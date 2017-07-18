// tslint:disable-next-line
require('source-map-support').install();
process.env.ISLAND_RPC_EXEC_TIMEOUT_MS = 1000;
process.env.ISLAND_RPC_WAIT_TIMEOUT_MS = 3000;
process.env.ISLAND_SERVICE_LOAD_TIME_MS = 1000;

import * as Bluebird from 'bluebird';

import { StatusExporter } from 'island-status-exporter';
import { RpcOptions } from '../controllers/rpc-decorator';
import paramSchemaInspector from '../middleware/schema.middleware';
import { AmqpChannelPoolService } from '../services/amqp-channel-pool-service';
import RPCService, { RpcHookType, RpcRequest, RpcResponse } from '../services/rpc-service';
import { AbstractEtcError, AbstractFatalError, AbstractLogicError, FatalError, ISLAND } from '../utils/error';
import { jasmineAsyncAdapter as spec } from '../utils/jasmine-async-support';
import { logger } from '../utils/logger';
import { TraceLog } from '../utils/tracelog';

// tslint:disable-next-line no-var-requires
const stdMocks = require('std-mocks');

async function mock(func) {
    stdMocks.use();
    await func();
    const output = stdMocks.flush();
    stdMocks.restore();
    return output;
}

describe('RpcResponse', () => {
  it('should handle malformed response', () => {
    const malformedJson = '{"result": true, "body": 1';
    expect(RpcResponse.decode(new Buffer(malformedJson))).toEqual({version: 0, result: false});
  });

  it('should understand an AbstractError object', () => {
    const error = new FatalError(ISLAND.FATAL.F0001_ISLET_ALREADY_HAS_BEEN_REGISTERED);
    const json = JSON.stringify({result: false, body: error});
    expect(RpcResponse.decode(new Buffer(json)).body).toEqual(jasmine.any(AbstractFatalError));
  });
});

describe('RPC test:', () => {
  const rpcService = new RPCService('haha');
  const amqpChannelPool = new AmqpChannelPoolService();
  beforeAll(spec(async () => {
    const url = process.env.RABBITMQ_HOST || 'amqp://rabbitmq:5672';
    await amqpChannelPool.initialize({ url });
    await rpcService.initialize(amqpChannelPool);
  }));

  afterAll(done => {
    rpcService.purge()
      .then(() => Bluebird.delay(100)) // to have time to send ack
      .then(() => amqpChannelPool.purge())
      .then(() => TraceLog.purge())
      .then(done)
      .catch(done.fail);
  });

  it('rpc test #1: rpc call', spec(async () => {
    await rpcService.register('testMethod', msg => {
      expect(msg).toBe('hello');
      return Promise.resolve('world');
    }, 'rpc');
    const res = await rpcService.invoke<string, string>('testMethod', 'hello');
    expect(res).toBe('world');
  }));

  it('rpc test #2: rpc call again', spec(async () => {
    const res = await rpcService.invoke<string, string>('testMethod', 'hello');
    expect(res).toBe('world');
  }));

  it('rpc test #3: purge', spec(async () => {
    await rpcService.unregister('testMethod');
  }));

  it('should handle Error()', spec(async ()  => {
    await rpcService.register('testMethod', msg => {
      throw new Error('custom error');
    }, 'rpc');
    try {
      await rpcService.invoke<string, string>('testMethod', 'hello');
    } catch (e) {
      expect(e instanceof AbstractEtcError).toBeTruthy();
      expect(e.code).toEqual(10020001);
      expect(e.name).toEqual('Error');
      expect(e.reason).toEqual('custom error');
      expect(e.extra.uuid).not.toBeFalsy();
    }
    await rpcService.unregister('testMethod');
  }));

  it('should handle TypeError()', spec(async ()  => {
    await rpcService.register('testMethod', msg => {
      const tmp: any = (() => undefined)();
      return tmp.xx;
    }, 'rpc');
    try {
      await rpcService.invoke<string, string>('testMethod', 'hello');
    } catch (e) {
      expect(e instanceof AbstractEtcError).toBeTruthy();
      expect(e.code).toEqual(10020001);
      expect(e.name).toEqual('TypeError');
      expect(e.reason).toEqual(`Cannot read property 'xx' of undefined`);
    }
    await rpcService.unregister('testMethod');
  }));

  it('should handle third-party error()', spec(async ()  => {
    await rpcService.register('testMethod', async msg => {
      await Bluebird.delay(100).timeout(10);
      return 1;
    }, 'rpc');
    try {
      await rpcService.invoke<string, string>('testMethod', 'hello');
    } catch (e) {
      expect(e instanceof AbstractEtcError).toBeTruthy();
      expect(e.code).toEqual(10020001);
      expect(e.name).toEqual('TimeoutError');
      expect(e.reason).toEqual('operation timed out');
      expect(e.extra.uuid).not.toBeFalsy();
    }
    await rpcService.unregister('testMethod');
  }));

  it('rpc test #5: should prevent to get new RPC request safely', spec(async () => {
    await rpcService.register('testMethod', async msg => {
      await Bluebird.delay(msg);
      return msg;
    }, 'rpc');
    const promises = [
      rpcService.invoke('testMethod', 100),
      rpcService.invoke('testMethod', 10)
        .then(async res => {
          await rpcService.pause('testMethod');
          return res;
        })
    ];
    const res = await Promise.all(promises);
    expect(res[0]).toEqual(100);
    expect(res[1]).toEqual(10);
  }));

  it('should respond an ongoing request despite purging', spec(async () => {
    await Promise.all([
      rpcService.register('AAA', async msg => {
        // Note: purge 시 ongoing Rpc 가 존재 할 경우, 처리 될 때까지 대기 하기 때문에 await 을 써줄 수 없게 됨.
        rpcService.purge();
        await Bluebird.delay(msg);
        return Promise.resolve('world');
      }, 'rpc'),
      rpcService.register('BBBB', async msg => {
        await Bluebird.delay(msg);
        return Promise.resolve('world');
      }, 'rpc')
    ]);
    await rpcService.invoke('AAA', 50);
  }));

  it('rpc test #7: rpc call with sanitizatioin, validation', spec(async () => {
    const sanitization  = { type: 'string' };
    const validation    = { type: 'string' };
    const rpcOptions: RpcOptions = {
      schema: {
        query:  { sanitization, validation },
        result: { sanitization, validation }
      }
    };
    await rpcService.register('testSchemaMethod', msg => Promise.resolve('world'), 'rpc', rpcOptions);
    const res = await rpcService.invoke<string, string>('testSchemaMethod', 'hello');
    expect(res).toBe('world');
  }));

  it('rpc test #8: rpc call with paramSchemaInspector', spec(async () => {
    const validation = { type: 'string' };
    const rpcOptions: RpcOptions = {
      schema: {
        query: { sanitization: {}, validation },
        result: { sanitization: {}, validation }
      }
    };
    const req: RpcRequest = {
      msg: {},
      name: 'test',
      options: rpcOptions
    };

    expect(() => {
      paramSchemaInspector(req);
    }).toThrowError(/.*10010002-Wrong parameter schema.*/);
  }));

  it('should unregister handlers if it failed to send a message', spec(async () => {
    const usingChannel = amqpChannelPool.usingChannel;
    (amqpChannelPool as any).usingChannel = async cb => {
      await cb({
        sendToQueue: (name, content, options) => { throw new Error('haha'); }
      });
    };

    try {
      await rpcService.invoke<string, string>('testMethod', 'hello');
      expect(true).toEqual(false);
    } catch (e) {
      expect(e.message).toEqual('haha');
    }
    expect((rpcService as any).waitingResponse).toEqual({});
    amqpChannelPool.usingChannel = usingChannel;
  }));

  it('should keeping a constant queue during restart the service', spec(async () => {
    await rpcService.register('testMethod3', msg => Promise.resolve('world'), 'rpc');
    await rpcService.purge();
    await amqpChannelPool.purge();
    await TraceLog.purge();

    const url = process.env.RABBITMQ_HOST || 'amqp://rabbitmq:5672';
    await amqpChannelPool.initialize({ url });
    await rpcService.initialize(amqpChannelPool);
    const p = rpcService.invoke<string, string>('testMethod3', 'hello');
    await Bluebird.delay(parseInt(process.env.ISLAND_RPC_WAIT_TIMEOUT_MS, 10) / 2);
    await rpcService.register('testMethod3', msg => Promise.resolve('world'), 'rpc');
    const res = await p;
    expect(res).toBe('world');
  }));

  it('should be able to pause and resume', spec(async () => {
    await rpcService.register('testPause', msg => Promise.resolve(msg + ' world'), 'rpc');
    await rpcService.pause('testPause');

    const p = rpcService.invoke<string, string>('testPause', 'hello');
    await rpcService.resume('testPause');
    const res = await p;
    expect(res).toBe('hello world');
  }));

  it('should know where the RPC error come from', spec(async () => {
    const rpcServiceSecond = new RPCService('second-island');
    await rpcServiceSecond.initialize(amqpChannelPool);
    const rpcServiceThird = new RPCService('third-island');
    await rpcServiceThird.initialize(amqpChannelPool);

    await rpcServiceThird.register('third', msg => {
      throw new Error('custom error');
    }, 'rpc');
    await rpcServiceSecond.register('second', async msg => {
      await rpcServiceSecond.invoke<string, string>('third', 'hello');
    }, 'rpc');
    await rpcService.register('first', async msg => {
      await rpcService.invoke<string, string>('second', 'hello');
    }, 'rpc');
    try {
      await rpcServiceSecond.invoke<string, string>('first', 'hello');
    } catch (e) {
      await rpcServiceSecond.unregister('second');
      await rpcServiceThird.unregister('third');

      expect(e instanceof AbstractEtcError).toBeTruthy();
      expect(e.code).toEqual(10020001);
      expect(e.name).toEqual('Error');
      expect(e.extra.island).toBe('third-island');
      expect(e.extra.rpcName).toBe('third');
    }
  }));

  it('should know where the RPC validation error come from', spec(async () => {
    const rpcServiceSecond = new RPCService('second-island');
    await rpcServiceSecond.initialize(amqpChannelPool);
    const rpcServiceThird = new RPCService('third-island');
    await rpcServiceThird.initialize(amqpChannelPool);
    const validation = { type: 'string' };
    const rpcOptions: RpcOptions = {
      schema: {
        query: { sanitization: {}, validation },
        result: { sanitization: {}, validation }
      }
    };

    await rpcServiceThird.register('third', msg => Promise.resolve('hello'), 'rpc', rpcOptions);

    await rpcServiceSecond.register('second', msg => {
      return rpcServiceSecond.invoke<any, string>('third', 1234);
    }, 'rpc');

    await rpcService.register('first', msg => {
      return rpcService.invoke<string, string>('second', 'hello');
    }, 'rpc');

    try {
      const p = await rpcServiceSecond.invoke<string, string>('first', 'hello');
      console.log(p);
    } catch (e) {
      await rpcServiceSecond.unregister('second');
      await rpcServiceThird.unregister('third');

      expect(e instanceof AbstractLogicError).toBeTruthy();
      expect(e.code).toEqual(10010002); // UNKNOWN/ISLANDJS/0002/WRONG_PARAMETER_SCHEMA
      expect(e.name).toEqual('LogicError');
      expect(e.extra.island).toBe('third-island');
      expect(e.extra.rpcName).toBe('third');
    }
  }));

  it('should show an extra info of an error', spec(async () => {
    await rpcService.register('hoho', req => {
      throw new FatalError(ISLAND.FATAL.F0001_ISLET_ALREADY_HAS_BEEN_REGISTERED);
    }, 'rpc');

    try {
      await rpcService.invoke('hoho', 'asdf');
    } catch (e) {
      expect(e.extra.rpcName).toEqual('hoho');
      expect(e.extra.req).toEqual('asdf');
    }
  }));
});

describe('RPC(isolated test)', () => {
  const rpcService = new RPCService('haha');
  const amqpChannelPool = new AmqpChannelPoolService();
  beforeEach(spec(async () => {
    const url = process.env.RABBITMQ_HOST || 'amqp://rabbitmq:5672';
    await amqpChannelPool.initialize({ url });
    await rpcService.initialize(amqpChannelPool);
  }));

  afterEach(done => {
    rpcService.purge()
      .then(() => Bluebird.delay(100)) // to have time to send ack
      .then(() => amqpChannelPool.purge())
      .then(() => TraceLog.purge())
      .then(done)
      .catch(done.fail);
  });

  it('should be canceled by timeout', spec(async () => {
    try {
      await rpcService.invoke('unmethod', 'arg');
      fail();
    } catch (e) {
      const rs = (rpcService as any);
      expect(e instanceof AbstractFatalError).toBeTruthy();
      expect(e.code).toEqual(10010023); // UNKNOWN/ISLANDJS/0023/RPC_TIMEOUT
      expect(e.extra.uuid).not.toBeFalsy();
      expect(rs.timedOutOrdered.length).toEqual(1);
      expect(rs.timedOut[rs.timedOutOrdered[0]]).toEqual('unmethod');
    }
  }));

  it('should ensure the uuid of the error raised by the RPC which has been timed out', spec(async () => {
    await rpcService.register('out', () => {
      return rpcService.invoke('unmethod', 'arg');
    }, 'rpc');
    try {
      await rpcService.invoke('out', 'abc');
      fail();
    } catch (e) {
      expect(e.extra.uuid).not.toBeFalsy();
    }
  }));

  it('should retry when it comes with 503 status code', spec(async () => {
    let called = 0;
    await rpcService.register('testMethod', msg => {
      called++;
      const e = new Error('custom error');
      (e as any).statusCode = 503;
      throw e;
    }, 'rpc');
    await rpcService.invoke('testMethod', 'hello').catch(e => e);
    expect(called).toBeGreaterThanOrEqual(2);
  }));

  it('should also return a raw buffer with an option', spec(async () => {
    await rpcService.register('testMethod', async () => {
      return 'haha';
    }, 'rpc');
    const res = await rpcService.invoke<string, {body: string, raw: Buffer}>
                        ('testMethod', 'hello', {withRawdata: true});
    expect(res.body).toEqual('haha');
    expect(res.raw).toEqual(jasmine.any(Buffer));
  }));

  it('should deprecate RPCService#_publish', spec(async () => {
    const output = await mock(async () => {
      await rpcService._publish('xexchange', 'xroutingKey', new Buffer('3'));
    });
    expect(output.stderr[0].split('\n')[0]).toEqual('Method `_publish` has been deprecated.');
  }));

  it('should shutdown when the response consumer is canceled', spec(async () => {
    const rs = (rpcService as any);
    const queue = rs.responseQueueName;
    spyOn(rs, 'shutdown');
    spyOn(logger, 'crit');
    await amqpChannelPool.usingChannel(async chan => chan.deleteQueue(queue));
    await Bluebird.delay(10);
    expect(logger.crit)
      .toHaveBeenCalledWith('The consumer is canceled, will lose following responses - https://goo.gl/HIgy4D');
    expect(rs.shutdown).toHaveBeenCalled();
  }));

  it('should handle a reponse with no correlationId', spec(async () => {
    const queue = (rpcService as any).responseQueueName;
    spyOn(logger, 'notice');
    await amqpChannelPool.usingChannel(async chan => chan.sendToQueue(queue, new Buffer('')));
    await Bluebird.delay(10);
    expect(logger.notice).toHaveBeenCalledWith('Got a response with no correlationId');
  }));

  it('should handle a response after timed out', spec(async () => {
    const rs = (rpcService as any);
    rs.timedOut.aaaa = 'unmethod';
    rs.timedOutOrdered.push('aaaa');
    const queue = rs.responseQueueName;
    spyOn(logger, 'warning');
    await amqpChannelPool.usingChannel(async chan => chan.sendToQueue(queue, new Buffer(''), {correlationId: 'aaaa'}));
    await Bluebird.delay(10);

    expect(logger.warning).toHaveBeenCalledWith('Got a response of `unmethod` after timed out - aaaa');
    expect(rs.timedOutOrdered.length).toEqual(0);
    expect(rs.timedOut).toEqual({});
  }));

  it('should handle an unknown reponse', spec(async () => {
    const rs = (rpcService as any);
    const queue = rs.responseQueueName;
    spyOn(logger, 'notice');
    await amqpChannelPool.usingChannel(async chan => chan.sendToQueue(queue, new Buffer(''), {correlationId: 'aaaa'}));
    await Bluebird.delay(50);

    expect(logger.notice).toHaveBeenCalledWith('Got an unknown response - aaaa');
  }));

  it('should keep original uuid through the RPCs', spec(async () => {
    let uuid;
    await rpcService.register('in', () => {
      const e = new FatalError(ISLAND.FATAL.F0001_ISLET_ALREADY_HAS_BEEN_REGISTERED);
      uuid = e.extra.uuid;
      throw e;
    }, 'rpc');
    await rpcService.register('out', () => rpcService.invoke('in', 'a'), 'rpc');
    try {
      await rpcService.invoke('out', 'b');
    } catch (e) {
      expect(e.extra.uuid).toEqual(uuid);
    }
  }));
});

describe('RPC with reviver', async () => {
  const url = process.env.RABBITMQ_HOST || 'amqp://rabbitmq:5672';
  const rpcService = new RPCService('haha');
  const amqpChannelPool = new AmqpChannelPoolService();

  async function invokeTest(opts?) {
    await rpcService.initialize(amqpChannelPool, opts);
    await rpcService.register('testMethod', msg => Promise.resolve(new Date().toISOString()), 'rpc');
    return await rpcService.invoke<string, any>('testMethod', 'hello');
  }

  beforeEach(spec(async () => {
    await amqpChannelPool.initialize({ url });
  }));

  afterEach(spec(async () => {
    await Bluebird.delay(100);
    await TraceLog.purge();
    await rpcService.purge();
    await amqpChannelPool.purge();
  }));

  it('should convert an ISODate string to Date', spec(async () => {
    const res = await invokeTest();
    expect(typeof res).toEqual('object');
    expect(res instanceof Date).toBeTruthy();
  }));

  it('should keep an ISODate string as string with noReviver', spec(async () => {
    const res = await invokeTest({ noReviver: true });
    expect(typeof res).toEqual('string');
    expect(res instanceof Date).toBeFalsy();
  }));
});

describe('RPC-hook', () => {
  const url = process.env.RABBITMQ_HOST || 'amqp://rabbitmq:5672';
  const rpcService = new RPCService('haha');
  const amqpChannelPool = new AmqpChannelPoolService();

  beforeEach(spec(async () => {
    await amqpChannelPool.initialize({ url });
    await rpcService.initialize(amqpChannelPool);
  }));

  afterEach(spec(async () => {
    await Bluebird.delay(100);
    await TraceLog.purge();
    await rpcService.purge();
    await amqpChannelPool.purge();
  }));

  it('could change the request body by pre-hook', spec(async () => {
    rpcService.registerHook(RpcHookType.PRE_RPC, content => Promise.resolve('hi, ' + content));
    await rpcService.register('testMethod', msg => Promise.resolve(msg + ' world'), 'rpc');
    const res = await rpcService.invoke('testMethod', 'hello');
    expect(res).toEqual('hi, hello world');
  }));

  it('could change the response body by post-hook', spec(async () => {
    rpcService.registerHook(RpcHookType.POST_RPC, content => {
      content.__fixed = true;
      return Promise.resolve(content);
    });
    await rpcService.register('testMethod', msg => Promise.resolve({[msg]: 'world'}), 'rpc');
    const res = await rpcService.invoke('testMethod', 'hello');
    expect(res).toEqual({__fixed: true, hello: 'world'});
  }));

  it('could add multiple pre-hooks', spec(async () => {
    rpcService.registerHook(RpcHookType.PRE_RPC, content => Promise.resolve('hi, ' + content));
    rpcService.registerHook(RpcHookType.PRE_RPC, content => Promise.resolve('hey, ' + content));
    await rpcService.register('testMethod', msg => Promise.resolve(msg + ' world'), 'rpc');
    const res = await rpcService.invoke('testMethod', 'hello');
    expect(res).toEqual('hey, hi, hello world');
  }));

  it('could add multiple post-hooks', spec(async () => {
    rpcService.registerHook(RpcHookType.POST_RPC, content => Promise.resolve({first: content}));
    rpcService.registerHook(RpcHookType.POST_RPC, content => Promise.resolve({second: content}));
    await rpcService.register('testMethod', msg => Promise.resolve({[msg]: 'world'}), 'rpc');
    const res = await rpcService.invoke('testMethod', 'hello');
    expect(res).toEqual({second: {first: {hello: 'world'}}});
  }));

  it('should share the hooks with every RPCs', spec(async () => {
    rpcService.registerHook(RpcHookType.PRE_RPC, content => Promise.resolve('hi-' + content));
    rpcService.registerHook(RpcHookType.PRE_RPC, content => Promise.resolve('hey-' + content));
    rpcService.registerHook(RpcHookType.POST_RPC, content => Promise.resolve({first: content}));
    rpcService.registerHook(RpcHookType.POST_RPC, content => Promise.resolve({second: content}));
    await rpcService.register('world', msg => Promise.resolve({[msg]: 'world'}), 'rpc');
    await rpcService.register('hell', msg => Promise.resolve({[msg]: 'hell'}), 'rpc');

    expect(await rpcService.invoke('world', 'hello'))
      .toEqual({second: {first: {'hey-hi-hello': 'world'}}});

    expect(await rpcService.invoke('hell', 'damn'))
      .toEqual({second: {first: {'hey-hi-damn': 'hell'}}});
  }));

  it('could change the error object before respond', spec(async () => {
    rpcService.registerHook(RpcHookType.PRE_RPC_ERROR, e => {
      e.extra = e.extra || {};
      e.extra.message = 'pre-hooked';
      return Promise.resolve(e);
    });
    await rpcService.register('world', msg => Promise.reject(new Error('custom error')), 'rpc');

    try {
      await rpcService.invoke('world', 'hello');
      expect(true).toEqual(false);
    } catch (e) {
      expect(e.message).toMatch(/custom error/);
      expect(e.extra.message).toEqual('pre-hooked');
    }
  }));

  it('could not change the error object with POST_RPC_ERROR', spec(async () => {
    let haveBeenCalled = false;
    rpcService.registerHook(RpcHookType.PRE_RPC_ERROR, e => {
      e.extra = e.extra || {};
      e.extra.message = 'pre-hooked';
      return Promise.resolve(e);
    });
    rpcService.registerHook(RpcHookType.POST_RPC_ERROR, e => {
      e.extra = e.extra || {};
      e.extra.message = 'post-hooked';
      haveBeenCalled = true;
      return Promise.resolve(e);
    });
    await rpcService.register('world', msg => Promise.reject(new Error('custom error')), 'rpc');

    try {
      await rpcService.invoke('world', 'hello');
      expect(true).toEqual(false);
    } catch (e) {
      await Bluebird.delay(1);
      expect(e.extra.message).toEqual('pre-hooked');
      expect(haveBeenCalled).toBeTruthy();
    }
  }));

  it('could reference the error object', spec(async () => {
    StatusExporter.initialize(true, 'rpc.status.json');
    await StatusExporter.saveStatusJsonFile();
  }));
});
