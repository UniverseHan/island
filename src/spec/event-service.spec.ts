import { StatusExporter } from 'island-status-exporter';

import { AmqpChannelPoolService } from '../services/amqp-channel-pool-service';
import { EventHookType, EventService } from '../services/event-service';
import { Event, PatternSubscriber } from '../services/event-subscriber';
import { jasmineAsyncAdapter as spec } from '../utils/jasmine-async-support';
import { TraceLog } from '../utils/tracelog';

import Bluebird = require('bluebird');

class BaseEvent<T> implements Event<T> {
  publishedAt: Date;
  constructor(public key: string, public args: T) {
  }
}

class TestEvent extends BaseEvent<string> {
  constructor(args: string) {
    super('test.event', args);
  }
}

class TestPatternEvent extends BaseEvent<string> {
  constructor(args: string) {
    super('test.pattern', args);
  }
}

describe('EventService', () => {
  const amqpChannelPool = new AmqpChannelPoolService();
  const eventService = new EventService(`event-service-spec`);

  beforeAll(done => {
    amqpChannelPool.initialize({
      url: process.env.RABBITMQ_HOST || 'amqp://rabbitmq:5672'
    })
      .then(() => eventService.initialize(amqpChannelPool))
      .then(() => eventService.startConsume())
      .then(done)
      .catch(done.fail);
  });

  it('can publish an event', done => {
    eventService.publishEvent(new TestEvent('aaa'))
      .then(done)
      .catch(done.fail);
  });

  it('can subscribe the event', done => {
    eventService.subscribeEvent(TestEvent, (event: TestEvent) => {
      expect(event.args).toBe('bbb');
      setTimeout(done, 500);
    })
      .then(() => eventService.publishEvent(new TestEvent('bbb')))
      .catch(done.fail);
  });

  it('can unsubscribe the event', done => {
    pending('can unsubscribe the event - not implemented');
  });

  it('can subscribe the event by a pattern', done => {
    eventService.subscribePattern('test.pattern', (event: TestPatternEvent) => {
      expect(event.key).toBe('test.pattern');
      setTimeout(done, 500);
    })
      .then(() => eventService.publishEvent(new TestPatternEvent('ccc')))
      .catch(done.fail);
  });

  it('can subscribe the event by an wildcard pattern', done => {
    eventService.subscribePattern('test.*', (event: TestPatternEvent) => {
      expect(event.key).toBe('test.pattern');
      expect(event.args).toBe('wildcard');
      setTimeout(done, 500);
    })
      .then(() => eventService.publishEvent(new TestPatternEvent('wildcard')))
      .catch(done.fail);
  });

  afterAll(done => {
    Bluebird.delay(500)
      .then(() => eventService.purge())
      .then(() => TraceLog.purge())
      .then(() => amqpChannelPool.purge())
      .then(done)
      .catch(done.fail);
  });
});

describe('PatternSubscriber', () => {
  describe('isRoutingKeyMatched', () => {
    it('should test a pattern with plain text', () => {
      const s = new PatternSubscriber(event => {
      }, 'aaa.aaa.aaa');
      expect(s.isRoutingKeyMatched('aaa.aaa.aaa')).toBeTruthy();
      expect(s.isRoutingKeyMatched('aaa.aaa.bbb')).toBeFalsy();
    });

    it('should test a pattern using *', () => {
      const s = new PatternSubscriber(event => {
      }, 'aaa.aaa.*');
      expect(s.isRoutingKeyMatched('aaa.aaa.aaa')).toBeTruthy();
      expect(s.isRoutingKeyMatched('aaa.aaa.bbb')).toBeTruthy();
      expect(s.isRoutingKeyMatched('aaa.bbb.aaa')).toBeFalsy();
      expect(s.isRoutingKeyMatched('aaa.aaa.aaa.aaa')).toBeFalsy();
    });

    it('should test a pattern using #', () => {
      const s = new PatternSubscriber(event => {
      }, 'aaa.#');
      expect(s.isRoutingKeyMatched('aaa.aaa.aaa')).toBeTruthy();
      expect(s.isRoutingKeyMatched('aaa.bbb.bbb')).toBeTruthy();
      expect(s.isRoutingKeyMatched('aaa.bbb')).toBeTruthy();
      expect(s.isRoutingKeyMatched('aaa')).toBeFalsy();
      expect(s.isRoutingKeyMatched('ccc.aaa.bbb')).toBeFalsy();
    });
  });
});

describe('Event-hook', () => {
  const amqpChannelPool = new AmqpChannelPoolService();
  const eventService = new EventService(`event-service-spec`);

  beforeEach(spec(async () => {
    await amqpChannelPool.initialize({
      url: process.env.RABBITMQ_HOST || 'amqp://rabbitmq:5672'
    });
    await eventService.initialize(amqpChannelPool);
    await eventService.startConsume();
  }));

  afterEach(spec(async () => {
    await Bluebird.delay(500);
    await TraceLog.purge();
    await eventService.purge();
    await amqpChannelPool.purge();
  }));

  it('could change the event parameter', spec(async () => {
    eventService.registerHook(EventHookType.EVENT, p => {
      return Promise.resolve('x' + p);
    });
    await eventService.subscribeEvent(TestEvent, (event: TestEvent) => {
      expect(event.args).toBe('xbbb');
    });
    await eventService.publishEvent(new TestEvent('bbb'));
  }));

  it('could reference the error object', spec(async () => {
    eventService.registerHook(EventHookType.ERROR, e => {
      expect(e.message).toMatch(/custom-event-error/);
      return Promise.resolve(e);
    });

    await eventService.subscribeEvent(TestEvent, (event: TestEvent) => {
      throw new Error('custom-event-error');
    });
    await eventService.publishEvent(new TestEvent('bbb'));
  }));

  it('could reference the error object', spec(async () => {
    StatusExporter.initialize(true, 'event.status.json');
    await StatusExporter.saveStatusJsonFile();
  }));
});
