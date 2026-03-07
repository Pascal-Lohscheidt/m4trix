import { describe, expect, test, vitest } from 'vitest';
import { Effect, Fiber, Queue } from 'effect';
import { Schema as S } from 'effect';
import { AgentFactory } from '../agent-factory';
import { AgentNetwork } from './agent-network';
import { AgentNetworkEvent, EventMeta } from './agent-network-event';
import {
  createEventPlane,
  run,
  runSubscriber,
  type Envelope,
} from './event-plane';
import { ChannelName } from './channel';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store';

const meta = { runId: 'test-run', contextId: 'test-context' };

describe('EventPlane', () => {
  describe('createEventPlane', () => {
    test('creates a plane with one PubSub per channel', async () => {
      const network = AgentNetwork.setup(({ mainChannel, createChannel }) => {
        mainChannel('main');
        createChannel('client');
      });

      const plane = await Effect.runPromise(createEventPlane({ network }));

      expect(plane.publish).toBeDefined();
      expect(plane.subscribe).toBeDefined();
      expect(plane.publishToChannels).toBeDefined();
      expect(plane.getRunEvents).toBeDefined();
      expect(plane.getContextEvents).toBeDefined();
      expect(plane.shutdown).toBeDefined();
    });

    test('accepts custom capacity', async () => {
      const network = AgentNetwork.setup(({ mainChannel }) => {
        mainChannel('main');
      });

      await Effect.runPromise(createEventPlane({ network, capacity: 32 }));
    });
  });

  describe('publish and subscribe', () => {
    test('subscriber receives published message', async () => {
      const network = AgentNetwork.setup(({ mainChannel }) => {
        mainChannel('main');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const dequeue = yield* plane.subscribe(ChannelName('main'));
        yield* plane.publish(ChannelName('main'), {
          name: 'test-event',
          meta,
          payload: { value: 42 },
        });
        const received = yield* Queue.take(dequeue);
        return received;
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toEqual({
        name: 'test-event',
        meta,
        payload: { value: 42 },
      });
    });

    test('multiple subscribers each receive the same message (broadcast)', async () => {
      const network = AgentNetwork.setup(({ mainChannel }) => {
        mainChannel('main');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const dequeue1 = yield* plane.subscribe(ChannelName('main'));
        const dequeue2 = yield* plane.subscribe(ChannelName('main'));

        yield* plane.publish(ChannelName('main'), {
          name: 'broadcast',
          meta,
          payload: {},
        });

        const [r1, r2] = yield* Effect.all([
          Queue.take(dequeue1),
          Queue.take(dequeue2),
        ]);
        return [r1, r2];
      });

      const [r1, r2] = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(r1).toEqual(r2);
      expect(r1).toMatchObject({ name: 'broadcast', meta });
    });
  });

  describe('publishToChannels', () => {
    test('publishes to all target channels', async () => {
      const network = AgentNetwork.setup(({ mainChannel, createChannel }) => {
        mainChannel('main');
        createChannel('client');
        createChannel('logs');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const channels = network.getChannels();
        const mainCh = channels.get('main')!;
        const clientCh = channels.get('client')!;
        const logsCh = channels.get('logs')!;

        const clientDequeue = yield* plane.subscribe(ChannelName('client'));
        const logsDequeue = yield* plane.subscribe(ChannelName('logs'));

        yield* plane.publishToChannels([clientCh, logsCh], {
          name: 'multi',
          meta,
          payload: { x: 1 },
        });

        const [fromClient, fromLogs] = yield* Effect.all([
          Queue.take(clientDequeue),
          Queue.take(logsDequeue),
        ]);

        return { fromClient, fromLogs, mainCh };
      });

      const { fromClient, fromLogs } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(fromClient).toMatchObject({ name: 'multi', payload: { x: 1 } });
      expect(fromLogs).toMatchObject({ name: 'multi', payload: { x: 1 } });
    });
  });

  describe('runSubscriber', () => {
    test('invokes agent with runEvents and contextEvents', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ x: S.Number }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ historyCount: S.Number, contextRunIds: S.Array(S.String) }),
      );

      const logicSpy = vitest.fn<
        [
          {
            triggerEvent: { meta: EventMeta; payload: { x: number } };
            emit: (e: unknown) => void;
            runEvents: readonly { name: string; meta: EventMeta; payload: unknown }[];
            contextEvents: {
              all: readonly { name: string; meta: EventMeta; payload: unknown }[];
              byRun(runId: string): readonly { name: string; meta: EventMeta; payload: unknown }[];
              map: ReadonlyMap<string, readonly { name: string; meta: EventMeta; payload: unknown }[]>;
            };
          },
        ],
        Promise<void>
      >(async ({ emit, runEvents, contextEvents }) => {
        const historyCount = runEvents.length;
        const contextRunIds = [...contextEvents.map.keys()];
        emit({
          name: 'response',
          payload: {
            historyCount,
            contextRunIds,
          },
        });
      });

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client');
          const agent = AgentFactory.run()
            .listensTo([requestEvt])
            .emits([responseEvt])
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .logic(logicSpy as any)
            .produce({});
          registerAgent(agent).subscribe(main).publishTo(client);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const [reg] = [...network.getAgentRegistrations().values()];
        const dequeue = yield* plane.subscribe(reg!.subscribedTo[0]!.name);

        const fiber = yield* runSubscriber(
          reg!.agent,
          reg!.publishesTo,
          dequeue,
          plane,
        );

        yield* plane.publish(reg!.subscribedTo[0]!.name, {
          name: 'request',
          meta: { runId: 'run-1', contextId: 'ctx-1' },
          payload: { x: 42 },
        });

        const clientDequeue = yield* plane.subscribe(reg!.publishesTo[0]!.name);
        const emitted = yield* Queue.take(clientDequeue);

        yield* Fiber.interrupt(fiber);

        return { emitted, logicSpy };
      });

      const { emitted, logicSpy: spy } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(emitted).toMatchObject({
        name: 'response',
        payload: { historyCount: 1, contextRunIds: ['run-1'] },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerEvent: expect.objectContaining({ payload: { x: 42 } }),
          runEvents: expect.any(Array),
          contextEvents: expect.objectContaining({
            all: expect.any(Array),
            byRun: expect.any(Function),
            map: expect.any(Map),
          }),
        }),
      );
    });

    test('invokes agent with envelope and wires emit to publish', async () => {
      const weatherSet = AgentNetworkEvent.of(
        'weather-set',
        S.Struct({ temp: S.Number }),
      );
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const logicSpy = vitest.fn<
        [
          {
            triggerEvent: { meta: EventMeta; payload: { temp: number } };
            emit: (e: unknown) => void;
          },
        ],
        Promise<void>
      >(async ({ triggerEvent, emit }) => {
        emit({
          name: 'weather-forecast-created',
          payload: { forecast: `Temp was ${triggerEvent.payload.temp}` },
        });
      });

      const WeatherAgent = AgentFactory.run()
        .listensTo([weatherSet])
        .emits([weatherForecast])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .logic(logicSpy as any);

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client');
          const agent = WeatherAgent.produce({});
          registerAgent(agent).subscribe(main).publishTo(client);
          return { main, client };
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const [reg] = [...network.getAgentRegistrations().values()];
        const dequeue = yield* plane.subscribe(reg!.subscribedTo[0]!.name);

        const fiber = yield* runSubscriber(
          reg!.agent,
          reg!.publishesTo,
          dequeue,
          plane,
        );

        yield* plane.publish(reg!.subscribedTo[0]!.name, {
          name: 'weather-set',
          meta,
          payload: { temp: 25 },
        });

        const clientDequeue = yield* plane.subscribe(reg!.publishesTo[0]!.name);
        const emitted = yield* Queue.take(clientDequeue);

        yield* Fiber.interrupt(fiber);

        return { emitted, logicSpy };
      });

      const { emitted, logicSpy: subscriberSpy } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(emitted).toMatchObject({
        name: 'weather-forecast-created',
        payload: { forecast: 'Temp was 25' },
      });
      expect(subscriberSpy).toHaveBeenCalledTimes(1);
      expect(subscriberSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerEvent: expect.objectContaining({
            name: 'weather-set',
            payload: { temp: 25 },
          }),
        }),
      );
    });

    test('does NOT invoke agent when event name is not in listensTo', async () => {
      const weatherSet = AgentNetworkEvent.of(
        'weather-set',
        S.Struct({ temp: S.Number }),
      );

      const filterSpy = vitest.fn().mockResolvedValue(undefined);

      const WeatherAgent = AgentFactory.run()
        .listensTo([weatherSet])
        .logic(filterSpy);

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client');
          const agent = WeatherAgent.produce({});
          registerAgent(agent).subscribe(main).publishTo(client);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const [reg] = [...network.getAgentRegistrations().values()];
        const dequeue = yield* plane.subscribe(reg!.subscribedTo[0]!.name);

        const fiber = yield* runSubscriber(
          reg!.agent,
          reg!.publishesTo,
          dequeue,
          plane,
        );

        yield* plane.publish(reg!.subscribedTo[0]!.name, {
          name: 'other-event',
          meta,
          payload: { ignored: true },
        });

        yield* Effect.sleep('20 millis');
        yield* Fiber.interrupt(fiber);

        return filterSpy;
      });

      const spy = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    test('agents receive and process published events', async () => {
      const weatherSet = AgentNetworkEvent.of(
        'weather-set',
        S.Struct({ temp: S.Number }),
      );
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const runLogicSpy = vitest.fn<
        [
          {
            triggerEvent: { meta: EventMeta; payload: { temp: number } };
            emit: (e: unknown) => void;
          },
        ],
        Promise<void>
      >(async ({ triggerEvent, emit }) => {
        emit({
          name: 'weather-forecast-created',
          payload: { forecast: `Temp was ${triggerEvent.payload.temp}` },
        });
      });

      const WeatherAgent = AgentFactory.run()
        .listensTo([weatherSet])
        .emits([weatherForecast])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .logic(runLogicSpy as any);

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client');
          const agent = WeatherAgent.produce({});
          registerAgent(agent).subscribe(main).publishTo(client);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const mainCh = network.getMainChannel()!;
        const clientCh = network.getChannels().get('client')!;

        const runFiber = yield* Effect.fork(
          run(network, plane).pipe(Effect.scoped),
        );

        yield* Effect.sleep('10 millis');

        const clientDequeue = yield* plane.subscribe(clientCh.name);
        yield* plane.publish(mainCh.name, {
          name: 'weather-set',
          meta,
          payload: { temp: 30 },
        });

        const emitted = yield* Queue.take(clientDequeue);

        yield* Fiber.interrupt(runFiber);

        return { emitted, runLogicSpy };
      });

      const { emitted, runLogicSpy: spy } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(emitted).toMatchObject({
        name: 'weather-forecast-created',
        payload: { forecast: 'Temp was 30' },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerEvent: expect.objectContaining({
            name: 'weather-set',
            payload: { temp: 30 },
          }),
        }),
      );
    });
  });

  describe('consecutive events in same store', () => {
    test('trigger event and agent-emitted event are stored in the same store', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ id: S.Number }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ echoed: S.Number }),
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client');
          const agent = AgentFactory.run()
            .listensTo([requestEvt])
            .emits([responseEvt])
            .logic(async ({ triggerEvent, emit }) => {
              emit({
                name: 'response',
                payload: { echoed: triggerEvent.payload.id },
              });
            })
            .produce({});
          registerAgent(agent).subscribe(main).publishTo(client);
        },
      );

      const program = Effect.gen(function* () {
        const store = createInMemoryNetworkStore<Envelope>();
        const plane = yield* createEventPlane({ network, store });
        const [reg] = [...network.getAgentRegistrations().values()];
        const dequeue = yield* plane.subscribe(reg!.subscribedTo[0]!.name);

        const fiber = yield* runSubscriber(
          reg!.agent,
          reg!.publishesTo,
          dequeue,
          plane,
        );

        yield* plane.publish(reg!.subscribedTo[0]!.name, {
          name: 'request',
          meta: { runId: 'run-1', contextId: 'ctx-1' },
          payload: { id: 99 },
        });

        const clientDequeue = yield* plane.subscribe(reg!.publishesTo[0]!.name);
        yield* Queue.take(clientDequeue);

        yield* Fiber.interrupt(fiber);

        const runEvents = plane.getRunEvents('run-1', 'ctx-1');
        const contextEvents = plane.getContextEvents('ctx-1');
        return { runEvents, contextEvents };
      });

      const { runEvents, contextEvents } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(runEvents).toHaveLength(2);
      expect(runEvents[0]).toMatchObject({
        name: 'request',
        payload: { id: 99 },
      });
      expect(runEvents[1]).toMatchObject({
        name: 'response',
        payload: { echoed: 99 },
      });
      expect(contextEvents.all).toHaveLength(2);
      expect(contextEvents.byRun('run-1')).toHaveLength(2);
    });
  });

  describe('getRunEvents and getContextEvents', () => {
    test('records events on publish and getRunEvents returns them', async () => {
      const network = AgentNetwork.setup(({ mainChannel }) => {
        mainChannel('main');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        yield* plane.publish(ChannelName('main'), {
          name: 'evt-1',
          meta: { runId: 'r1', contextId: 'c1' },
          payload: { x: 1 },
        });
        yield* plane.publish(ChannelName('main'), {
          name: 'evt-2',
          meta: { runId: 'r1', contextId: 'c1' },
          payload: { x: 2 },
        });

        return plane.getRunEvents('r1', 'c1');
      });

      const events = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ name: 'evt-1', payload: { x: 1 } });
      expect(events[1]).toMatchObject({ name: 'evt-2', payload: { x: 2 } });
    });

    test('getRunEvents returns empty for unknown runId or contextId', async () => {
      const network = AgentNetwork.setup(({ mainChannel }) => {
        mainChannel('main');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        return plane.getRunEvents('unknown-run', 'unknown-context');
      });

      const events = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(events).toHaveLength(0);
    });

    test('getContextEvents returns map of event arrays by runId', async () => {
      const network = AgentNetwork.setup(({ mainChannel }) => {
        mainChannel('main');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        yield* plane.publish(ChannelName('main'), {
          name: 'a',
          meta: { runId: 'run-1', contextId: 'ctx' },
          payload: {},
        });
        yield* plane.publish(ChannelName('main'), {
          name: 'b',
          meta: { runId: 'run-2', contextId: 'ctx' },
          payload: {},
        });
        yield* plane.publish(ChannelName('main'), {
          name: 'c',
          meta: { runId: 'run-1', contextId: 'ctx' },
          payload: {},
        });

        const contextEvents = plane.getContextEvents('ctx');
        expect(contextEvents.map.size).toBe(2);
        expect(contextEvents.map.has('run-1')).toBe(true);
        expect(contextEvents.map.has('run-2')).toBe(true);

        const run1Events = contextEvents.byRun('run-1');
        const run2Events = contextEvents.byRun('run-2');

        return { run1Events, run2Events, contextEvents };
      });

      const { run1Events, run2Events, contextEvents } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(run1Events).toHaveLength(2);
      expect(run1Events[0]).toMatchObject({ name: 'a' });
      expect(run1Events[1]).toMatchObject({ name: 'c' });
      expect(run2Events).toHaveLength(1);
      expect(run2Events[0]).toMatchObject({ name: 'b' });

      expect(contextEvents.all).toHaveLength(3);
      expect(contextEvents.all.map((e) => e.name)).toEqual(
        expect.arrayContaining(['a', 'b', 'c']),
      );
    });

    test('records events on publishToChannels only once per envelope', async () => {
      const network = AgentNetwork.setup(({ mainChannel, createChannel }) => {
        mainChannel('main');
        createChannel('client');
        createChannel('logs');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const channels = network.getChannels();
        const clientCh = channels.get('client')!;
        const logsCh = channels.get('logs')!;

        yield* plane.publishToChannels([clientCh, logsCh], {
          name: 'multi-channel',
          meta: { runId: 'r1', contextId: 'c1' },
          payload: { once: true },
        });

        return plane.getRunEvents('r1', 'c1');
      });

      const events = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: 'multi-channel',
        payload: { once: true },
      });
    });
  });

  describe('shutdown', () => {
    test('shuts down all PubSubs', async () => {
      const network = AgentNetwork.setup(({ mainChannel }) => {
        mainChannel('main');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        yield* plane.shutdown;
      });

      await Effect.runPromise(program);
    });
  });
});
