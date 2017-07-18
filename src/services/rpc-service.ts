import * as cls from 'continuation-local-storage';

import * as amqp from 'amqplib';
import * as Bluebird from 'bluebird';
import deprecated from 'deprecated-decorator';
import * as _ from 'lodash';
import * as os from 'os';
import uuid = require('uuid');

import { RpcOptions } from '../controllers/rpc-decorator';
import { sanitize, validate } from '../middleware/schema.middleware';
import { AbstractError, FatalError, ISLAND, LogicError, mergeIslandJsError } from '../utils/error';
import { logger } from '../utils/logger';
import reviver from '../utils/reviver';
import { RpcRequest } from '../utils/rpc-request';
import { IRpcResponse, RpcResponse } from '../utils/rpc-response';
import { exporter } from '../utils/status-exporter';
import { TraceLog } from '../utils/tracelog';
import { AmqpChannelPoolService } from './amqp-channel-pool-service';

export { IRpcResponse, RpcRequest, RpcResponse };

const RPC_EXEC_TIMEOUT_MS = parseInt(process.env.ISLAND_RPC_EXEC_TIMEOUT_MS, 10) || 25000;
const RPC_WAIT_TIMEOUT_MS = parseInt(process.env.ISLAND_RPC_WAIT_TIMEOUT_MS, 10) || 60000;
const SERVICE_LOAD_TIME_MS = parseInt(process.env.ISLAND_SERVICE_LOAD_TIME_MS, 10) || 60000;
const RPC_QUEUE_EXPIRES_MS = RPC_WAIT_TIMEOUT_MS + SERVICE_LOAD_TIME_MS;

export interface IConsumerInfo {
  channel: amqp.Channel;
  tag: string;
  options?: RpcOptions;
  key: string;
  consumer: (msg: any) => Promise<void>;
  consumerOpts?: any;
}

interface Message {
  content: Buffer;
  properties: amqp.Options.Publish;
}

export type RpcHook = (rpc) => Promise<any>;
export enum RpcHookType {
  PRE_ENDPOINT,
  POST_ENDPOINT,
  PRE_RPC,
  POST_RPC,
  PRE_ENDPOINT_ERROR,
  POST_ENDPOINT_ERROR,
  PRE_RPC_ERROR,
  POST_RPC_ERROR
}

export interface InitializeOptions {
  noReviver?: boolean;
}

function createTraceLog({ tattoo, timestamp, msg, headers, rpcName, serviceName }) {
  const log = new TraceLog(tattoo, timestamp);
  log.size = msg.content.byteLength;
  log.from = headers.from;
  log.to = { node: process.env.HOSTNAME, context: rpcName, island: serviceName, type: 'rpc' };
  return log;
}

function sanitizeAndValidate(content, rpcOptions) {
  if (rpcOptions) {
    if (_.get(rpcOptions, 'schema.query.sanitization')) {
      content = sanitize(rpcOptions.schema!.query!.sanitization, content);
    }
    if (_.get(rpcOptions, 'schema.query.validation')) {
      if (!validate(rpcOptions.schema!.query!.validation, content)) {
        throw new LogicError(ISLAND.LOGIC.L0002_WRONG_PARAMETER_SCHEMA, `Wrong parameter schema`);
      }
    }
  }
  return content;
}

function sanitizeAndValidateResult(res, rpcOptions?: RpcOptions) {
  if (!rpcOptions) return res;
  if (_.get(rpcOptions, 'schema.result.sanitization')) {
    res = sanitize(rpcOptions.schema!.result!.sanitization, res);
  }
  if (_.get(rpcOptions, 'schema.result.validation')) {
    validate(rpcOptions.schema!.result!.validation, res);
  }
  return res;
}

function nackWithDelay(channel, msg) {
  setTimeout(() => channel.nack(msg), 1000) as any;
}

type DeferredResponse = { resolve: (msg: Message) => any, reject: (e: Error) => any };

export default class RPCService {
  private consumerInfosMap: { [name: string]: IConsumerInfo } = {};
  private responseQueueName: string;
  private responseConsumerInfo: IConsumerInfo;
  private waitingResponse: { [corrId: string]: DeferredResponse } = {};
  private timedOut: { [corrId: string]: string } = {};
  private timedOutOrdered: string[] = [];
  private channelPool: AmqpChannelPoolService;
  private serviceName: string;
  private hooks: { [key: string]: RpcHook[] };
  private onGoingRpcRequestCount: number = 0;
  private purging: Function | null = null;

  constructor(serviceName?: string) {
    this.serviceName = serviceName || 'unknown';
    this.hooks = {};
  }

  public async initialize(channelPool: AmqpChannelPoolService, opts?: InitializeOptions): Promise<any> {
    if (opts && opts.noReviver) {
      RpcResponse.reviver = undefined;
    } else {
      RpcResponse.reviver = reviver;
    }
    this.responseQueueName = this.makeResponseQueueName();
    logger.info(`consuming ${this.responseQueueName}`);

    await TraceLog.initialize();

    this.channelPool = channelPool;
    await channelPool.usingChannel(channel => channel.assertQueue(this.responseQueueName, { exclusive: true }));

    this.responseConsumerInfo = await this.consumeForResponse();
  }

  @deprecated()
  public _publish(exchange: any, routingKey: any, content: any, options?: any) {
    return this.channelPool.usingChannel(channel => {
      return Promise.resolve(channel.publish(exchange, routingKey, content, options));
    });
  }

  public async purge() {
    return Promise.all(_.map(this.consumerInfosMap, async consumerInfo => {
      logger.info('stop serving', consumerInfo.key);
      await this.pause(consumerInfo.key);
      delete this.consumerInfosMap[consumerInfo.key];
    }))
      .then(async () => {
        if (this.onGoingRpcRequestCount > 0) {
          return new Promise((res, rej) => { this.purging = res; });
        }
      })
      .then(() => {
        this.hooks = {};
        this.timedOut = {};
        this.timedOutOrdered = [];
      });
  }

  public registerHook(type: RpcHookType, hook: RpcHook) {
    this.hooks[type] = this.hooks[type] || [];
    this.hooks[type].push(hook);
  }

  public async register(rpcName: string,
                        handler: (req: any) => Promise<any>,
                        type: 'endpoint' | 'rpc',
                        rpcOptions?: RpcOptions): Promise<void> {
    await this.channelPool.usingChannel(channel => channel.assertQueue(rpcName, {
      arguments : {'x-expires': RPC_QUEUE_EXPIRES_MS},
      durable   : false
    }));

    this.consumerInfosMap[rpcName] = await this._consume(rpcName, (msg: Message) => {
      const { replyTo, headers, correlationId } = msg.properties;
      if (!replyTo) throw ISLAND.FATAL.F0026_MISSING_REPLYTO_IN_RPC;

      const tattoo = headers && headers.tattoo;
      const timestamp = msg.properties.timestamp || 0;
      const log = createTraceLog({ tattoo, timestamp, msg, headers, rpcName, serviceName: this.serviceName });
      return this.enterCLS(tattoo, rpcName, async () => {
        const options = { correlationId, headers };
        const parsed = JSON.parse(msg.content.toString('utf8'), reviver);
        try {
          this.onGoingRpcRequestCount++;
          await Bluebird.resolve()
            .then(()  => sanitizeAndValidate(parsed, rpcOptions))
            .tap (req => logger.debug(`Got ${rpcName} with ${JSON.stringify(req)}`))
            .then(req => this.dohook('pre', type, req))
            .then(req => handler(req))
            .then(res => this.dohook('post', type, res))
            .then(res => sanitizeAndValidateResult(res, rpcOptions))
            .then(res => this.reply(replyTo, res, options))
            .tap (()  => log.end())
            .tap (res => logger.debug(`responses ${JSON.stringify(res)}`))
            .timeout(RPC_EXEC_TIMEOUT_MS);
        } catch (err) {
          await Bluebird.resolve(err)
            .then(err => this.earlyThrowWith503(rpcName, err, msg))
            .tap (err => log.end(err))
            .then(err => this.dohook('pre-error', type, err))
            .then(err => this.attachExtraError(err, rpcName, parsed))
            .then(err => this.reply(replyTo, err, options))
            .then(err => this.dohook('post-error', type, err))
            .tap (err => this.logRpcError(err));
          throw err;
        } finally {
          log.shoot();
          exporter.pushTransactionData(type, rpcName);
          if (--this.onGoingRpcRequestCount < 1 && this.purging) {
            this.purging();
          }
        }
      });
    });
  }

  public async pause(name: string) {
    const consumerInfo = this.consumerInfosMap[name];
    if (!consumerInfo) return;
    await consumerInfo.channel.cancel(consumerInfo.tag);
  }

  public async resume(name: string) {
    const consumerInfo = this.consumerInfosMap[name];
    if (!consumerInfo) return;
    await consumerInfo.channel.consume(consumerInfo.key, consumerInfo.consumer);
  }

  public async unregister(name: string) {
    const consumerInfo = this.consumerInfosMap[name];
    if (!consumerInfo) return;

    await this._cancel(consumerInfo);
    delete this.consumerInfosMap[name];
  }

  public async invoke<T, U>(name: string, msg: T, opts?: {withRawdata: boolean}): Promise<U>;
  public async invoke(name: string, msg: any, opts?: {withRawdata: boolean}): Promise<any> {
    let startAt;
    const option = this.makeInvokeOption();
    const p = this.waitResponse(option.correlationId!, (msg: Message) => {
      const responseTime = +new Date() - startAt;
      const res = RpcResponse.decode(msg.content);
      exporter.pushTimeData('rpc', name, responseTime);
      if (res.result === false) throw res.body;
      if (opts && opts.withRawdata) return { body: res.body, raw: msg.content };
      return res.body;
    })
      .timeout(RPC_WAIT_TIMEOUT_MS)
      .catch(Bluebird.TimeoutError, () => this.throwTimeout(name, option.correlationId!))
      .catch(err => {
        err.tattoo = option.headers.tattoo;
        throw err;
      });

    const content = new Buffer(JSON.stringify(msg), 'utf8');
    try {
      await this.channelPool.usingChannel(async chan => chan.sendToQueue(name, content, option));
      startAt = +new Date();
    } catch (e) {
      this.waitingResponse[option.correlationId!].reject(e);
      delete this.waitingResponse[option.correlationId!];
    }
    return await p;
  }

  // There are two kind of consumes - get requested / get a response
  // * get-requested consumers can be multiple per a node and they shares a RPC queue between island nodes
  // * get-a-response consumer is only one per a node and it has an exclusive queue
  protected async _consume(key: string, handler: (msg) => Promise<any>): Promise<IConsumerInfo> {
    const channel = await this.channelPool.acquireChannel();
    const prefetchCount = await this.channelPool.getPrefetchCount();
    await channel.prefetch(prefetchCount || +process.env.RPC_PREFETCH || 1000);

    const consumer = async msg => {
      try {
        await handler(msg);
        channel.ack(msg);
      } catch (error) {
        if (this.is503(error)) return nackWithDelay(channel, msg);
        if (this.isCritical(error)) return this.shutdown();
        channel.ack(msg);
      }
    };
    const result = await channel.consume(key, consumer);
    return { channel, tag: result.consumerTag, key, consumer };
  }

  protected async _cancel(consumerInfo: IConsumerInfo): Promise<void> {
    await consumerInfo.channel.cancel(consumerInfo.tag);
    await this.channelPool.releaseChannel(consumerInfo.channel);
  }

  private throwTimeout(name, corrId: string) {
    delete this.waitingResponse[corrId];
    this.timedOut[corrId] = name;
    this.timedOutOrdered.push(corrId);
    if (20 < this.timedOutOrdered.length) {
      delete this.timedOut[this.timedOutOrdered.shift()!];
    }
    const err = new FatalError(ISLAND.FATAL.F0023_RPC_TIMEOUT,
                               `RPC(${name}) does not return in ${RPC_WAIT_TIMEOUT_MS} ms`);
    err.statusCode = 504;
    throw err;
  }

  private shutdown() {
    process.emit('SIGTERM');
  }

  private makeResponseQueueName() {
    // NOTE: live docker 환경에서는 같은 hostname + process.pid 조합이 유일하지 않을 수 있다
    // docker 내부의 process id 는 1인 경우가 대부분이며 host=net으로 실행시키는 경우 hostname도 동일할 수 있다.
    return `rpc.res.${this.serviceName}.${os.hostname()}.${uuid.v4()}`;
  }

  private consumeForResponse() {
    return this._consume(this.responseQueueName, (msg: Message | null) => {
      if (!msg) {
        logger.crit(`The consumer is canceled, will lose following responses - https://goo.gl/HIgy4D`);
        throw new FatalError(ISLAND.FATAL.F0027_CONSUMER_IS_CANCELED);
      }
      const correlationId = msg.properties.correlationId;
      if (!correlationId) {
        logger.notice('Got a response with no correlationId');
        return;
      }
      if (this.timedOut[correlationId]) {
        const name = this.timedOut[correlationId];
        delete this.timedOut[correlationId];
        _.pull(this.timedOutOrdered, correlationId);

        logger.warning(`Got a response of \`${name}\` after timed out - ${correlationId}`);
        return;
      }
      const waiting = this.waitingResponse[correlationId];
      if (!waiting) {
        logger.notice(`Got an unknown response - ${correlationId}`);
        return;
      }
      delete this.waitingResponse[correlationId];
      return waiting.resolve(msg);
    });
  }

  private waitResponse(corrId: string, handleResponse: (msg: Message) => any) {
    return new Bluebird((resolve, reject) => {
      this.waitingResponse[corrId] = { resolve, reject };
    }).then((msg: Message) => {
      const clsScoped = cls.getNamespace('app').bind((msg: Message) => {
        delete this.waitingResponse[corrId];
        return handleResponse(msg);
      });
      return clsScoped(msg);
    });
  }

  private makeInvokeOption(): amqp.Options.Publish {
    const ns = cls.getNamespace('app');
    const tattoo = ns.get('RequestTrackId');
    const context = ns.get('Context');
    const type = ns.get('Type');
    const correlationId = uuid.v4();
    const headers = {
      tattoo,
      from: { node: process.env.HOSTNAME, context, island: this.serviceName, type }
    };
    return {
      correlationId,
      expiration: RPC_WAIT_TIMEOUT_MS,
      headers,
      replyTo: this.responseQueueName,
      timestamp: +(new Date())
    };
  }

  // 503(Service Temporarily Unavailable) 오류일 때는 응답을 caller에게 안보내줘야함
  private async earlyThrowWith503(rpcName, err, msg) {
    // Requeue the message when it has a chance
    if (this.is503(err)) throw err;
    return err;
  }

  private is503(err) {
    return err.statusCode && parseInt(err.statusCode, 10) === 503;
  }

  private isCritical(err) {
    return err.code === mergeIslandJsError(ISLAND.FATAL.F0027_CONSUMER_IS_CANCELED);
  }

  private logRpcError(err) {
    logger.error(`Got an error during ${err.extra.island}/${err.extra.rpcName}` +
      ` with ${JSON.stringify(err.extra.req)} - ${err.stack}`);
  }

  private attachExtraError(err: AbstractError, rpcName: string, req: any) {
    err.extra = _.defaults({}, err.extra, { island: this.serviceName, rpcName, req });
    err.extra = AbstractError.ensureUuid(err.extra);
    return err;
  }

  // returns value again for convenience
  private async reply(replyTo: string, value: any, options: amqp.Options.Publish) {
    await this.channelPool.usingChannel(async channel => {
      return channel.sendToQueue(replyTo, RpcResponse.encode(value), options);
    });
    return value;
  }

  // enter continuation-local-storage scope
  private enterCLS(tattoo, rpcName, func) {
    const properties = { RequestTrackId: tattoo, Context: rpcName, Type: 'rpc' };
    return new Promise((resolve, reject) => {
      const ns = cls.getNamespace('app');
      ns.run(() => {
        _.each(properties, (value, key: string) => {
          ns.set(key, value);
        });
        Bluebird.try(func).then(resolve).catch(reject);
      });
    });
  }

  private async dohook(prefix: 'pre' | 'post' | 'pre-error' | 'post-error', type: 'endpoint' | 'rpc', value) {
    const hookType = {
      endpoint: {
        pre: RpcHookType.PRE_ENDPOINT, post: RpcHookType.POST_ENDPOINT,
        'pre-error': RpcHookType.PRE_ENDPOINT_ERROR, 'post-error': RpcHookType.POST_ENDPOINT_ERROR
      },
      rpc: {
        pre: RpcHookType.PRE_RPC, post: RpcHookType.POST_RPC,
        'pre-error': RpcHookType.PRE_RPC_ERROR, 'post-error': RpcHookType.POST_RPC_ERROR
      }
    }[type][prefix];
    const hook = this.hooks[hookType];
    if (!hook) return value;
    return Bluebird.reduce(this.hooks[hookType], (value, hook) => hook(value), value);
  }
}
