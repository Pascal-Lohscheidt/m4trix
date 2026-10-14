import { Effect, Fiber, Queue, Schema as S } from 'effect';
import { describe, expect, test, vitest } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network.js';
import { AgentNetworkEvent, type EventMeta } from './agent-network-event.js';
import { ChannelName } from './channel.js';
import { createEventPlane, type Envelope, run, startAgents } from './event-plane.js';
import type { EventHistory } from './history.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

const meta = { runId: 'test-run', contextId: 'test-context' };

function requireChannel(network: AgentNetwork, name: string) {
  const channel = network.getChannels().get(name);
  if (!channel) {
    throw new Error(`Expected channel ${name} to exist`);
  }
  return channel;
}

function requireMainChannel(network: AgentNetwork) {
  const channel = network.getMainChannel();
  if (!channel) {
    throw new Error('Expected main channel to exist');
  }
  return channel;
}

/** Networks whose worker channel is read with `plane.subscribe` rather than by agents. */
const workerReaders: AgentNetworkSetupOptions = { wiring: { ignore: ['unconsumed-event'] } };
describe('EventPlane', () => {
  describe('createEventPlane', () => {
    test('creates a plane with one PubSub per channel', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
      });

      const plane = await Effect.runPromise(createEventPlane({ network }));

      expect(plane.publish).toBeDefined();
      expect(plane.subscribe).toBeDefined();
      expect(plane.publishToChannels).toBeDefined();
      expect(plane.history).toBeDefined();
      expect(plane.shutdown).toBeDefined();
    });

    test('accepts custom capacity', async () => {
      const network = AgentNetwork.setup(() => {});

      await Effect.runPromise(createEventPlane({ network, capacity: 32 }));
    });
  });

  describe('publish and subscribe', () => {
    test('subscriber receives published message', async () => {
      const network = AgentNetwork.setup(() => {});

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
        meta: { ...meta, eventId: expect.any(String), ts: expect.any(Number), depth: 0 },
        payload: { value: 42 },
      });
    });

    test('multiple subscribers each receive the same message (broadcast)', async () => {
      const network = AgentNetwork.setup(() => {});

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const dequeue1 = yield* plane.subscribe(ChannelName('main'));
        const dequeue2 = yield* plane.subscribe(ChannelName('main'));

        yield* plane.publish(ChannelName('main'), {
          name: 'broadcast',
          meta,
          payload: {},
        });

        const [r1, r2] = yield* Effect.all([Queue.take(dequeue1), Queue.take(dequeue2)]);
        return [r1, r2];
      });

      const [r1, r2] = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(r1).toEqual(r2);
      expect(r1).toMatchObject({ name: 'broadcast', meta });
    });
  });

  describe('publishToChannels', () => {
    test('publishes to all target channels', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
        createChannel('logs');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const mainCh = requireChannel(network, 'main');
        const clientCh = requireChannel(network, 'client');
        const logsCh = requireChannel(network, 'logs');

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

      const { fromClient, fromLogs } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(fromClient).toMatchObject({ name: 'multi', payload: { x: 1 } });
      expect(fromLogs).toMatchObject({ name: 'multi', payload: { x: 1 } });
    });
  });

  describe('publishAndAwait', () => {
    test('resolves when a later event matches the predicate', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const clientCh = requireChannel(network, 'client');

        const waiter = yield* Effect.fork(
          plane.publishAndAwait(
            [clientCh],
            {
              name: 'request',
              meta: { ...meta, correlationId: 'corr-1' },
              payload: { id: 1 },
            },
            (reply) => reply.name === 'response' && reply.meta.correlationId === 'corr-1',
          ),
        );

        yield* Effect.sleep('1 millis');
        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta: { ...meta, correlationId: 'corr-1' },
          payload: { ok: true },
        });

        return yield* Fiber.join(waiter);
      });

      const reply = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(reply).toMatchObject({
        name: 'response',
        meta: { correlationId: 'corr-1' },
        payload: { ok: true },
      });
    });

    test('ignores non-matching events', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const clientCh = requireChannel(network, 'client');

        const waiter = yield* Effect.fork(
          plane.publishAndAwait(
            [clientCh],
            {
              name: 'request',
              meta: { ...meta, correlationId: 'corr-2' },
              payload: {},
            },
            (reply) => reply.name === 'response' && reply.meta.correlationId === 'corr-2',
          ),
        );

        yield* Effect.sleep('1 millis');
        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta: { ...meta, correlationId: 'other-corr' },
          payload: { ignored: true },
        });
        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta: { ...meta, correlationId: 'corr-2' },
          payload: { ok: true },
        });

        return yield* Fiber.join(waiter);
      });

      const reply = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(reply).toMatchObject({
        name: 'response',
        meta: { correlationId: 'corr-2' },
        payload: { ok: true },
      });
    });

    test('auto-unregisters a waiter after a match', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
      });
      const matchSpy = vitest.fn((reply: Envelope) => reply.name === 'response');

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const clientCh = requireChannel(network, 'client');

        const waiter = yield* Effect.fork(
          plane.publishAndAwait(
            [clientCh],
            {
              name: 'request',
              meta,
              payload: {},
            },
            matchSpy,
          ),
        );

        yield* Effect.sleep('1 millis');
        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta,
          payload: { n: 1 },
        });
        const reply = yield* Fiber.join(waiter);

        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta,
          payload: { n: 2 },
        });

        return reply;
      });

      const reply = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(reply).toMatchObject({ payload: { n: 1 } });
      expect(matchSpy).toHaveBeenCalledTimes(1);
    });

    test('times out and unregisters when no event matches', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
      });
      const matchSpy = vitest.fn((reply: Envelope) => reply.name === 'response');

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const clientCh = requireChannel(network, 'client');

        const first = yield* Effect.either(
          plane.publishAndAwait(
            [clientCh],
            {
              name: 'request',
              meta,
              payload: {},
            },
            matchSpy,
            { timeout: '10 millis' },
          ),
        );

        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta,
          payload: { tooLate: true },
        });

        return first;
      });

      const result = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(result._tag).toBe('Left');
      expect(matchSpy).not.toHaveBeenCalled();
    });

    test('keeps concurrent waiters isolated by correlation id', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const clientCh = requireChannel(network, 'client');

        const waiterA = yield* Effect.fork(
          plane.publishAndAwait(
            [clientCh],
            {
              name: 'request',
              meta: { ...meta, correlationId: 'corr-a' },
              payload: {},
            },
            (reply) => reply.name === 'response' && reply.meta.correlationId === 'corr-a',
          ),
        );
        const waiterB = yield* Effect.fork(
          plane.publishAndAwait(
            [clientCh],
            {
              name: 'request',
              meta: { ...meta, correlationId: 'corr-b' },
              payload: {},
            },
            (reply) => reply.name === 'response' && reply.meta.correlationId === 'corr-b',
          ),
        );

        yield* Effect.sleep('1 millis');
        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta: { ...meta, correlationId: 'corr-b' },
          payload: { value: 'b' },
        });
        yield* plane.publish(clientCh.name, {
          name: 'response',
          meta: { ...meta, correlationId: 'corr-a' },
          payload: { value: 'a' },
        });

        const [replyA, replyB] = yield* Effect.all([Fiber.join(waiterA), Fiber.join(waiterB)]);
        return { replyA, replyB };
      });

      const { replyA, replyB } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(replyA).toMatchObject({ payload: { value: 'a' } });
      expect(replyB).toMatchObject({ payload: { value: 'b' } });
    });
  });

  describe('startAgents', () => {
    test('invokes agent with the history of its run and context', async () => {
      const requestEvt = AgentNetworkEvent.of('request', S.Struct({ x: S.Number }));
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ historyCount: S.Number, contextRunIds: S.Array(S.String) }),
      );

      const logicSpy = vitest.fn<
        (ctx: {
          triggerEvent: { meta: EventMeta; payload: { x: number } };
          emit: (e: unknown) => void;
          history: EventHistory;
        }) => Promise<void>
      >(async ({ emit, history }) => {
        const historyCount = (await history.run()).length;
        const contextRunIds = [
          ...new Set((await history.context()).events.map((e) => e.meta.runId)),
        ];
        emit({
          name: 'response',
          payload: {
            historyCount,
            contextRunIds,
          },
        });
      });

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');
        const agent = AgentFactory.run()
          .listensTo([requestEvt])
          .emits([responseEvt])
          // biome-ignore lint/suspicious/noExplicitAny: needed for builder pattern
          .logic(logicSpy as any)
          .produce({});
        registerAgent(agent).subscribe(main).publishTo(client);
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        yield* startAgents(network, plane);

        yield* plane.publish(requireMainChannel(network).name, {
          name: 'request',
          meta: { runId: 'run-1', contextId: 'ctx-1' },
          payload: { x: 42 },
        });

        const clientDequeue = yield* plane.subscribe(requireChannel(network, 'client').name);
        const emitted = yield* Queue.take(clientDequeue);

        return { emitted, logicSpy };
      });

      const { emitted, logicSpy: spy } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(emitted).toMatchObject({
        name: 'response',
        payload: { historyCount: 1, contextRunIds: ['run-1'] },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerEvent: expect.objectContaining({ payload: { x: 42 } }),
          history: expect.objectContaining({
            run: expect.any(Function),
            context: expect.any(Function),
          }),
        }),
      );
    });

    test('invokes agent with envelope and wires emit to publish', async () => {
      const weatherSet = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const logicSpy = vitest.fn<
        (ctx: {
          triggerEvent: { meta: EventMeta; payload: { temp: number } };
          emit: (e: unknown) => void;
        }) => Promise<void>
      >(async ({ triggerEvent, emit }) => {
        emit({
          name: 'weather-forecast-created',
          payload: { forecast: `Temp was ${triggerEvent.payload.temp}` },
        });
      });

      const WeatherAgent = AgentFactory.run()
        .listensTo([weatherSet])
        .emits([weatherForecast])
        // biome-ignore lint/suspicious/noExplicitAny: needed for builder pattern
        .logic(logicSpy as any);

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');
        const agent = WeatherAgent.produce({});
        registerAgent(agent).subscribe(main).publishTo(client);
        return { main, client };
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        yield* startAgents(network, plane);

        yield* plane.publish(requireMainChannel(network).name, {
          name: 'weather-set',
          meta,
          payload: { temp: 25 },
        });

        const clientDequeue = yield* plane.subscribe(requireChannel(network, 'client').name);
        const emitted = yield* Queue.take(clientDequeue);

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
      const weatherSet = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));

      const filterSpy = vitest.fn().mockResolvedValue(undefined);

      const WeatherAgent = AgentFactory.run().listensTo([weatherSet]).logic(filterSpy);

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');
        const agent = WeatherAgent.produce({});
        registerAgent(agent).subscribe(main).publishTo(client);
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        yield* startAgents(network, plane);

        yield* plane.publish(requireMainChannel(network).name, {
          name: 'other-event',
          meta,
          payload: { ignored: true },
        });

        yield* Effect.sleep('20 millis');
        return filterSpy;
      });

      const spy = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    test('agents receive and process published events', async () => {
      const weatherSet = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const runLogicSpy = vitest.fn<
        (ctx: {
          triggerEvent: { meta: EventMeta; payload: { temp: number } };
          emit: (e: unknown) => void;
        }) => Promise<void>
      >(async ({ triggerEvent, emit }) => {
        emit({
          name: 'weather-forecast-created',
          payload: { forecast: `Temp was ${triggerEvent.payload.temp}` },
        });
      });

      const WeatherAgent = AgentFactory.run()
        .listensTo([weatherSet])
        .emits([weatherForecast])
        // biome-ignore lint/suspicious/noExplicitAny: needed for builder pattern
        .logic(runLogicSpy as any);

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');
        const agent = WeatherAgent.produce({});
        registerAgent(agent).subscribe(main).publishTo(client);
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const mainCh = requireMainChannel(network);
        const clientCh = requireChannel(network, 'client');

        const runFiber = yield* Effect.fork(run(network, plane).pipe(Effect.scoped));

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

      const { emitted, runLogicSpy: spy } = await Effect.runPromise(program.pipe(Effect.scoped));

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

    test('agent can emitAndAwait a reply produced by another subscriber', async () => {
      const Start = AgentNetworkEvent.of('start', S.Struct({ id: S.String }));
      const TaskRequested = AgentNetworkEvent.of('task-requested', S.Struct({ id: S.String }));
      const TaskResult = AgentNetworkEvent.of(
        'task-result',
        S.Struct({ id: S.String, value: S.String }),
      );
      const Final = AgentNetworkEvent.of('final', S.Struct({ id: S.String, value: S.String }));

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const worker = createChannel('worker');
        const client = createChannel('client');
        const orchestrator = AgentFactory.run()
          .listensTo([Start])
          .emits([TaskRequested, Final])
          .logic(async ({ triggerEvent, emit, emitAndAwait }) => {
            const reply = await emitAndAwait(
              TaskRequested.make({ id: triggerEvent.payload.id }),
              (event) => event.name === 'task-result',
              { timeout: '100 millis' },
            );
            const payload = reply.payload as { value: string };
            emit(Final.make({ id: triggerEvent.payload.id, value: payload.value }));
          })
          .produce({});
        const workerAgent = AgentFactory.run()
          .listensTo([TaskRequested])
          .emits([TaskResult])
          .logic(async ({ triggerEvent, emit }) => {
            emit(TaskResult.make({ id: triggerEvent.payload.id, value: 'done' }));
          })
          .produce({});

        registerAgent(orchestrator).subscribe(mainChannel).publishTo(worker);
        registerAgent(workerAgent).subscribe(worker).publishTo(client);
        // `final` is read with plane.subscribe on the worker channel.
      }, workerReaders);

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const mainCh = requireMainChannel(network);
        const workerCh = requireChannel(network, 'worker');
        const workerDequeue = yield* plane.subscribe(workerCh.name);
        const runFiber = yield* Effect.fork(run(network, plane).pipe(Effect.scoped));

        yield* Effect.sleep('10 millis');
        yield* plane.publish(mainCh.name, {
          name: 'start',
          meta,
          payload: { id: 'task-1' },
        });

        const request = yield* Queue.take(workerDequeue);
        const final = yield* Queue.take(workerDequeue);

        yield* Fiber.interrupt(runFiber);

        return { request, final };
      });

      const { request, final } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(request).toMatchObject({
        name: 'task-requested',
        meta: { correlationId: expect.any(String) },
        payload: { id: 'task-1' },
      });
      expect(final).toMatchObject({
        name: 'final',
        payload: { id: 'task-1', value: 'done' },
      });
    });

    test('emitAndAwait times out and unregisters its waiter when no subscriber replies', async () => {
      const Start = AgentNetworkEvent.of('start', S.Struct({ id: S.String }));
      const TaskRequested = AgentNetworkEvent.of('task-requested', S.Struct({ id: S.String }));
      const Failed = AgentNetworkEvent.of('failed', S.Struct({ message: S.String }));
      const matchSpy = vitest.fn((event: Envelope) => event.name === 'task-result');

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const worker = createChannel('worker');
        createChannel('client');
        const orchestrator = AgentFactory.run()
          .listensTo([Start])
          .emits([TaskRequested, Failed])
          .logic(async ({ triggerEvent, emit, emitAndAwait }) => {
            try {
              await emitAndAwait(TaskRequested.make({ id: triggerEvent.payload.id }), matchSpy, {
                timeout: '10 millis',
              });
            } catch (error) {
              emit(Failed.make({ message: (error as Error).message }));
            }
          })
          .produce({});

        registerAgent(orchestrator).subscribe(mainChannel).publishTo(worker);
        // Nobody answers on purpose; the test reads the worker channel itself.
      }, workerReaders);

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const mainCh = requireMainChannel(network);
        const workerCh = requireChannel(network, 'worker');
        const clientCh = requireChannel(network, 'client');
        const workerDequeue = yield* plane.subscribe(workerCh.name);
        const runFiber = yield* Effect.fork(run(network, plane).pipe(Effect.scoped));

        yield* Effect.sleep('10 millis');
        yield* plane.publish(mainCh.name, {
          name: 'start',
          meta,
          payload: { id: 'task-1' },
        });

        const request = yield* Queue.take(workerDequeue);
        const failed = yield* Queue.take(workerDequeue);

        yield* plane.publish(clientCh.name, {
          name: 'task-result',
          meta: { ...meta, correlationId: request.meta.correlationId },
          payload: { late: true },
        });
        yield* Effect.sleep('20 millis');

        yield* Fiber.interrupt(runFiber);

        return { failed };
      });

      const { failed } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(failed).toMatchObject({
        name: 'failed',
        payload: { message: expect.stringContaining('publishAndAwait timed out') },
      });
      expect(matchSpy).not.toHaveBeenCalled();
    });
  });

  describe('consecutive events in same store', () => {
    test('trigger event and agent-emitted event are stored in the same store', async () => {
      const requestEvt = AgentNetworkEvent.of('request', S.Struct({ id: S.Number }));
      const responseEvt = AgentNetworkEvent.of('response', S.Struct({ echoed: S.Number }));

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
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
      });

      const program = Effect.gen(function* () {
        const store = createInMemoryNetworkStore();
        const plane = yield* createEventPlane({ network, store });
        yield* startAgents(network, plane);

        yield* plane.publish(requireMainChannel(network).name, {
          name: 'request',
          meta: { runId: 'run-1', contextId: 'ctx-1' },
          payload: { id: 99 },
        });

        const clientDequeue = yield* plane.subscribe(requireChannel(network, 'client').name);
        yield* Queue.take(clientDequeue);

        const history = plane.history({ runId: 'run-1', contextId: 'ctx-1' });
        const runEvents = yield* Effect.promise(() => history.run());
        const contextEvents = yield* Effect.promise(() => history.context());
        const stored = yield* Effect.promise(() =>
          store.readRun({ namespace: 'anonymous', contextId: 'ctx-1' }, 'run-1'),
        );
        return { runEvents, contextEvents, stored };
      });

      const { runEvents, contextEvents, stored } = await Effect.runPromise(
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
      expect(contextEvents.events).toHaveLength(2);
      expect(stored).toEqual(runEvents);
    });
  });

  describe('plane.history', () => {
    test('records events on publish and history.run() returns them', async () => {
      const network = AgentNetwork.setup(() => {});

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

        return yield* Effect.promise(() => plane.history({ runId: 'r1', contextId: 'c1' }).run());
      });

      const events = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ name: 'evt-1', payload: { x: 1 } });
      expect(events[1]).toMatchObject({ name: 'evt-2', payload: { x: 2 } });
    });

    test('history is empty for unknown runId or contextId', async () => {
      const network = AgentNetwork.setup(() => {});

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        return yield* Effect.promise(() =>
          plane.history({ runId: 'unknown-run', contextId: 'unknown-context' }).run(),
        );
      });

      const events = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(events).toHaveLength(0);
    });

    test('history.context() returns the events of every run of the context', async () => {
      const network = AgentNetwork.setup(() => {});

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

        const read = (runId: string) =>
          Effect.promise(() => plane.history({ runId, contextId: 'ctx' }).run());
        const run1Events = yield* read('run-1');
        const run2Events = yield* read('run-2');
        const contextEvents = yield* Effect.promise(() =>
          plane.history({ runId: 'run-1', contextId: 'ctx' }).context(),
        );

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

      expect(contextEvents.events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
    });

    test('records events on publishToChannels only once per envelope', async () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
        createChannel('logs');
      });

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        const clientCh = requireChannel(network, 'client');
        const logsCh = requireChannel(network, 'logs');

        yield* plane.publishToChannels([clientCh, logsCh], {
          name: 'multi-channel',
          meta: { runId: 'r1', contextId: 'c1' },
          payload: { once: true },
        });

        return yield* Effect.promise(() => plane.history({ runId: 'r1', contextId: 'c1' }).run());
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
      const network = AgentNetwork.setup(() => {});

      const program = Effect.gen(function* () {
        const plane = yield* createEventPlane({ network });
        yield* plane.shutdown;
      });

      await Effect.runPromise(program);
    });
  });
});
