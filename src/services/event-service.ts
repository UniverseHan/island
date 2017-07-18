import * as cls from 'continuation-local-storage';

import * as amqp from 'amqplib';
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as uuid from 'uuid';

import { Events } from '../utils/event';
import { logger } from '../utils/logger';
import reviver from '../utils/reviver';
import { TraceLog } from '../utils/tracelog';

import { exporter } from '../utils/status-exporter';

import { AmqpChannelPoolService } from './amqp-channel-pool-service';
import {
  BaseEvent,
  Event,
  EventHandler,
  EventSubscriber,
  Message,
  PatternSubscriber,
  Subscriber
} from './event-subscriber';

export type EventHook = (obj) => Promise<any>;
export enum EventHookType {
  EVENT,
  ERROR
}

function enterScope(properties: any, func): Promise<any> {
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

export class EventService {
  private static EXCHANGE_NAME: string = 'MESSAGE_BROKER_EXCHANGE';
  private channelPool: AmqpChannelPoolService;
  private roundRobinQ: string;
  private fanoutQ: string;
  private subscribers: Subscriber[] = [];
  private serviceName: string;
  private hooks: { [key: string]: EventHook[] } = {};
  private onGoingEventRequestCount: number = 0;
  private purging: Function | null = null;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.roundRobinQ = `event.${serviceName}`;
    this.fanoutQ = `event.${serviceName}.node.${uuid.v4()}`;
  }

  async initialize(channelPool: AmqpChannelPoolService): Promise<any> {
    await TraceLog.initialize();

    this.channelPool = channelPool;
    return channelPool.usingChannel(channel => {
      return channel.assertExchange(EventService.EXCHANGE_NAME, 'topic', { durable: true })
        .then(() => channel.assertQueue(this.roundRobinQ, { durable: true, exclusive: false }))
        .then(() => channel.assertQueue(this.fanoutQ, { exclusive: true, autoDelete: true }));
    });
  }

  async startConsume(): Promise<any> {
    const channel = await this.channelPool.acquireChannel();

    await Bluebird.map([this.roundRobinQ, this.fanoutQ], queue => {
      this.registerConsumer(channel, queue);
    });
    this.publishEvent(new Events.SystemNodeStarted({ name: this.fanoutQ, island: this.serviceName }));
  }

  async purge(): Promise<any> {
    this.hooks = {};
    if (!this.subscribers) return Promise.resolve();
    return Promise.all(_.map(this.subscribers, async subscriber => {
      logger.info('stop consuming', subscriber.getRoutingPattern());
      await this.unsubscribe(subscriber);
    }))
      .then((): Promise<any> => {
        this.subscribers = [];
        if (this.onGoingEventRequestCount > 0) {
          return new Promise((res, rej) => { this.purging = res; });
        }
        return Promise.resolve();
      });
  }

  subscribeEvent<T extends Event<U>, U>(eventClass: new (args: U) => T,
                                        handler: EventHandler<T>,
                                        options?: SubscriptionOptions): Promise<void> {
    return Promise.resolve(Bluebird.try(() => new EventSubscriber(handler, eventClass))
      .then(subscriber => this.subscribe(subscriber, options)));
  }

  subscribePattern(pattern: string,
                   handler: EventHandler<Event<any>>,
                   options?: SubscriptionOptions): Promise<void> {
    return Promise.resolve(Bluebird.try(() => new PatternSubscriber(handler, pattern))
      .then(subscriber => this.subscribe(subscriber, options)));
  }

  publishEvent<T extends Event<U>, U>(exchange: string, event: T): Promise<any>;
  publishEvent<T extends Event<U>, U>(event: T): Promise<any>;
  publishEvent(...args): Promise<any> {
    let exchange = EventService.EXCHANGE_NAME;
    let event: Event<{}>;
    if (args.length === 1) {
      event = args[0];
    } else {
      exchange = args[0];
      event = args[1];
    }
    const ns = cls.getNamespace('app');
    const tattoo = ns.get('RequestTrackId');
    const context = ns.get('Context');
    const type = ns.get('Type');
    logger.debug(`publish ${event.key}`, event.args, tattoo);
    const options = {
      headers: {
        tattoo,
        from: { node: process.env.HOSTNAME, context, island: this.serviceName, type }
      },
      timestamp: +new Date()
    };
    return Promise.resolve(Bluebird.try(() => new Buffer(JSON.stringify(event.args), 'utf8'))
      .then(content => {
        return this._publish(EventService.EXCHANGE_NAME, event.key, content, options);
      }));
  }

  registerHook(type: EventHookType, hook: EventHook) {
    this.hooks[type] = this.hooks[type] || [];
    this.hooks[type].push(hook);
  }

  private registerConsumer(channel: amqp.Channel, queue: string): Promise<any> {
    const prefetchCount = this.channelPool.getPrefetchCount();
    return Promise.resolve(channel.prefetch(prefetchCount || +process.env.EVENT_PREFETCH || 1000))
      .then(() => channel.consume(queue, msg => {
        if (!msg) {
          logger.error(`consume was canceled unexpectedly`);
          // TODO: handle unexpected cancel
          return;
        }
        const receiveMessageTimeByMQ = +new Date() - msg.properties.timestamp;
        this.onGoingEventRequestCount++;
        Bluebird.resolve(this.handleMessage(msg))
          .catch(e => this.sendErrorLog(e, msg))
          .finally(() => {
            channel.ack(msg);
            exporter.pushTransactionAndTimeData('event', msg.fields && msg.fields.routingKey, receiveMessageTimeByMQ);
            if (--this.onGoingEventRequestCount < 1 && this.purging) {
              this.purging();
            }
            // todo: fix me. we're doing ACK always even if promise rejected.
            // todo: how can we handle the case subscribers succeeds or fails partially
          });
      }));
    // TODO: save channel and consumer tag
  }

  private async sendErrorLog(err: Error, msg: Message): Promise<any> {
    logger.error(`error on handling event`, err);
    if ('ExpectedError' === err.name) return;
    if ('log.error' === msg.fields.routingKey) return; // preventing loop

    const errorLog = {
      message: err.message,
      params: (() => {
        try {
          return JSON.parse(msg.content.toString('utf8'), reviver);
        } catch (e) {
          return msg.content;
        }
      })(),
      stack: err.stack
    };
    _.assign(errorLog, err);
    return this.publishEvent(new BaseEvent('log.error', errorLog));
  }

  private async dohook(type: EventHookType, value) {
    if (!this.hooks[type]) return value;
    return Bluebird.reduce(this.hooks[type], async (value, hook) => await hook(value), value);
  }

  private async handleMessage(msg: Message): Promise<any> {
    const headers = msg.properties.headers;
    const tattoo = headers && headers.tattoo;
    const content = await this.dohook(EventHookType.EVENT, JSON.parse(msg.content.toString('utf8'), reviver));
    const subscribers = this.subscribers.filter(subscriber => subscriber.isRoutingKeyMatched(msg.fields.routingKey));
    const promise = Bluebird.map(subscribers, subscriber => {
      return enterScope({ RequestTrackId: tattoo, Context: msg.fields.routingKey, Type: 'event' }, () => {
        logger.debug(`${msg.fields.routingKey}`, content, msg.properties.headers);
        const log = new TraceLog(tattoo, msg.properties.timestamp || 0);
        log.size = msg.content.byteLength;
        log.from = headers.from;
        log.to = {
          context: msg.fields.routingKey,
          island: this.serviceName,
          node: process.env.HOSTNAME,
          type: 'event'
        };

        return Bluebird.resolve(subscriber.handleEvent(content, msg))
          .then(() => {
            log.end();
          })
          .catch(async e => {
            if (!e.extra || typeof e.extra === 'object') {
              e.extra = _.assign({
                args: content,
                event: msg.fields.routingKey,
                island: this.serviceName
              }, e.extra);
            }
            e = await this.dohook(EventHookType.ERROR, e);
            log.end(e);
            throw e;
          })
          .finally(() => {
            log.shoot();
          });
      });
    });
    return Promise.resolve(promise);
  }

  private subscribe(subscriber: Subscriber, options?: SubscriptionOptions): Promise<void> {
    options = options || {};
    subscriber.setQueue(options.everyNodeListen && this.fanoutQ || this.roundRobinQ);
    return this.channelPool.usingChannel(channel => {
      return channel.bindQueue(subscriber.getQueue(), EventService.EXCHANGE_NAME, subscriber.getRoutingPattern());
    })
      .then(() => {
        this.subscribers.push(subscriber);
      });
  }

  private _publish(exchange: string, routingKey: string, content, options): Promise<any> {
    return this.channelPool.usingChannel(channel => {
      return Promise.resolve(channel.publish(exchange, routingKey, content, options));
    });
  }

  private unsubscribe(subscriber: Subscriber) {
    const queue = subscriber.getQueue();
    if (!queue) return;
    return this.channelPool.usingChannel(channel => {
      if (queue === this.roundRobinQ)
        return channel.unbindExchange(queue, EventService.EXCHANGE_NAME, subscriber.getRoutingPattern());
      return channel.unbindQueue(queue, EventService.EXCHANGE_NAME, subscriber.getRoutingPattern());
    });
  }
}

export interface SubscriptionOptions {
  everyNodeListen?: boolean;
}
