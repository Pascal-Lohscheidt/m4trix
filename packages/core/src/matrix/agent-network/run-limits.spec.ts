import { Effect, Queue, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { ChannelName } from '../identifiers/channel-name.js';
import { registerSSEStream, type SseProxyConsumerOptions } from '../io/proxy-consumer.js';
import type { ExposedStream } from '../io/types.js';
import { Tool } from '../tool.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network.js';
import { AgentNetworkEvent, type EventMeta } from './agent-network-event.js';
import type { Envelope, EventPlane } from './event-plane.js';
import {
  DEFAULT_RUN_MAX_DEPTH,
  DEFAULT_RUN_MAX_EVENTS,
  type RunFailedPayload,
  RunLifecycleEvent,
  type RunLimitName,
  type RunLimitOptions,
} from './run-lifecycle.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const note = AgentNetworkEvent.of('note', S.Struct({ from: S.String }));
const ask = AgentNetworkEvent.of('ask', S.Struct({}));
const answer = AgentNetworkEvent.of('answer', S.Struct({}));
const done = AgentNetworkEvent.of('done', S.Struct({}));

const ping = AgentNetworkEvent.of('ping', S.Struct({ n: S.Number }));
const pong = AgentNetworkEvent.of('pong', S.Struct({ n: S.Number }));
const tick = AgentNetworkEvent.of('tick', S.Struct({ n: S.Number }), { transient: true });

const main = ChannelName('main');
const meta = (runId: string) => ({ runId, contextId: 'ctx' });

const byName = (events: readonly Envelope[], name: string): Envelope => {
  const found = events.find((e) => e.name === name);
  if (!found) throw new Error(`no ${name} event`);
  return found;
};

/** Networks whose events are read from the store or with `plane.subscribe`, not by agents. */
const storeReaders: AgentNetworkSetupOptions = { wiring: { ignore: ['unconsumed-event'] } };
describe('event meta', () => {
  test('every published envelope gets an eventId, ts and depth; emits point to their cause', async () => {
    const noteTool = Tool.of({ name: 'note', description: 'Leaves a note' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .emits([note])
      .define(({ emit }) => {
        emit(note.make({ from: 'tool' }));
        return {};
      });
    const network = AgentNetwork.setup(({ mainChannel, registerAgent, endsOn }) => {
      registerAgent(
        AgentFactory.run()
          .listensTo([start])
          .emits([note, ask, done])
          .tools(noteTool)
          .logic(async ({ emit, emitAndAwait, tools }) => {
            emit(note.make({ from: 'agent' }));
            await tools.toTools()[0]?.execute({});
            await emitAndAwait(ask.make({}), (e) => e.name === 'answer');
            emit(done.make({}));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(mainChannel);
      registerAgent(
        AgentFactory.run()
          .listensTo([ask])
          .emits([answer], { reply: true })
          .logic(async ({ emit }) => emit(answer.make({})))
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(mainChannel);
      endsOn(done);
      // Notes are only read back from the run's history.
    }, storeReaders);

    const before = Date.now();
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* plane.publish(main, start.makeBound(meta('run-1'), {}));
        yield* plane.awaitRunEnd('run-1');
        yield* Effect.sleep('10 millis');
        return yield* Effect.promise(() =>
          plane.history({ runId: 'run-1', contextId: 'ctx' }).run(),
        );
      }).pipe(Effect.scoped),
    );

    expect(events.map((e) => e.name)).toEqual([
      'start',
      'note',
      'note',
      'ask',
      'answer',
      'done',
      RunLifecycleEvent.completed,
    ]);
    for (const event of events) {
      expect(event.meta.eventId).toEqual(expect.any(String));
      expect(event.meta.ts).toBeGreaterThanOrEqual(before);
    }
    expect(new Set(events.map((e) => e.meta.eventId)).size).toBe(events.length);

    const startEvent = byName(events, 'start');
    const askEvent = byName(events, 'ask');
    const answerEvent = byName(events, 'answer');
    expect(startEvent.meta).not.toHaveProperty('causationId');
    expect(startEvent.meta.depth).toBe(0);
    // Agent emits, tool emits and emitAndAwait requests are one hop from their trigger.
    for (const event of events.filter((e) => ['note', 'ask', 'done'].includes(e.name))) {
      expect(event.meta).toMatchObject({ depth: 1, causationId: startEvent.meta.eventId });
    }
    // The reply is caused by the request and keeps its correlation id.
    expect(answerEvent.meta).toMatchObject({
      depth: 2,
      causationId: askEvent.meta.eventId,
      correlationId: askEvent.meta.correlationId,
    });
    expect(askEvent.meta.correlationId).toEqual(expect.any(String));
  });

  test('meta set by the publisher is kept', async () => {
    const network = AgentNetwork.setup(({ mainChannel }) => {
      void mainChannel;
    });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* plane.publish(
          main,
          start.makeBound({ ...meta('run-1'), eventId: 'evt-1', ts: 42, depth: 3 }, {}),
        );
        return yield* Effect.promise(() =>
          plane.history({ runId: 'run-1', contextId: 'ctx' }).run(),
        );
      }).pipe(Effect.scoped),
    );

    expect(events[0]?.meta).toEqual({ ...meta('run-1'), eventId: 'evt-1', ts: 42, depth: 3 });
  });

  test('the new meta fields are optional on decode', () => {
    expect(start.makeBound(meta('run-1'), {}).meta).toEqual(meta('run-1'));
    expectTypeOf<EventMeta['eventId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EventMeta['depth']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<EventMeta['ts']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<EventMeta['causationId']>().toEqualTypeOf<string | undefined>();
  });
});

/**
 * A pings B on the start event and on every pong; B pongs every ping. Without a depth limit the
 * run only ends once A has seen `stopAfter` pongs.
 */
function pingPongNetwork(options: AgentNetworkSetupOptions = {}, stopAfter = Infinity) {
  const invocations = { a: 0, b: 0 };
  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
      createChannel('client').proxy(proxy.sse());
      registerAgent(
        AgentFactory.run()
          .listensTo([start, pong])
          .emits([ping, done])
          .logic(async ({ triggerEvent, emit }) => {
            invocations.a++;
            const n = triggerEvent.name === 'pong' ? triggerEvent.payload.n : 0;
            emit(n >= stopAfter ? done.make({}) : ping.make({ n: n + 1 }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(mainChannel);
      registerAgent(
        AgentFactory.run()
          .listensTo([ping])
          .emits([pong])
          .logic(async ({ triggerEvent, emit }) => {
            invocations.b++;
            emit(pong.make({ n: triggerEvent.payload.n }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(mainChannel);
      endsOn(done);
    },
    options,
  );
  return { network, invocations };
}

/** Publishes the start event of `runId` and returns the run's events once it ended. */
function runToEnd(plane: EventPlane, runId: string) {
  return Effect.gen(function* () {
    yield* plane.publish(main, start.makeBound(meta(runId), {}));
    const outcome = yield* plane.awaitRunEnd(runId);
    yield* Effect.sleep('10 millis');
    const events = yield* Effect.promise(() => plane.history({ runId, contextId: 'ctx' }).run());
    return { outcome, events };
  });
}

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

function post(): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

const limitFailure = (limit: RunLimitName, max: number) => ({
  name: RunLifecycleEvent.failed,
  payload: {
    error: {
      name: 'RunLimitExceededError',
      message: expect.stringContaining(String(max)),
      kind: 'limit-exceeded',
      limit,
      max,
    },
  },
});

describe('run limits', () => {
  describe('maxDepth', () => {
    test('an A→B→A ping-pong loop fails the run at the configured depth', async () => {
      const { network, invocations } = pingPongNetwork({ maxDepth: 5 });

      const { outcome, events } = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* runToEnd(yield* network.run(), 'run-1');
        }).pipe(Effect.scoped),
      );

      // start(0) ping(1) pong(2) ping(3) pong(4) ping(5); pong(6) is over the limit.
      expect(events.map((e) => `${e.name}@${e.meta.depth}`)).toEqual([
        'start@0',
        'ping@1',
        'pong@2',
        'ping@3',
        'pong@4',
        'ping@5',
        `${RunLifecycleEvent.failed}@0`,
      ]);
      expect(events.at(-1)).toMatchObject(limitFailure('depth', 5));
      expect(outcome).toMatchObject({
        status: 'failed',
        payload: limitFailure('depth', 5).payload,
      });
      expect(invocations).toEqual({ a: 3, b: 3 });
    });

    test('defaults to 25 hops', async () => {
      const { network } = pingPongNetwork();

      const { events } = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* runToEnd(yield* network.run(), 'run-1');
        }).pipe(Effect.scoped),
      );

      expect(DEFAULT_RUN_MAX_DEPTH).toBe(25);
      expect(Math.max(...events.map((e) => e.meta.depth ?? 0))).toBe(25);
      expect(events.at(-1)).toMatchObject(limitFailure('depth', 25));
    });

    test('Infinity disables it', async () => {
      const { network } = pingPongNetwork({ maxDepth: Infinity }, 30);

      const { outcome } = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* runToEnd(yield* network.run(), 'run-1');
        }).pipe(Effect.scoped),
      );

      expect(outcome).toMatchObject({ status: 'completed' });
    });
  });

  describe('maxEvents', () => {
    test('fails the run once it published more durable events; the extra event is not delivered', async () => {
      const notesSeen: number[] = [];
      let emitterSignal: AbortSignal | undefined;
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          registerAgent(
            AgentFactory.run()
              .listensTo([start])
              .emits([ping])
              .logic(async ({ emit, signal }) => {
                emitterSignal = signal;
                for (let n = 1; n <= 10; n++) emit(ping.make({ n }));
                await new Promise((resolve) => signal.addEventListener('abort', resolve));
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(mainChannel);
          registerAgent(
            AgentFactory.run()
              .listensTo([ping])
              .logic(async ({ triggerEvent }) => {
                notesSeen.push(triggerEvent.payload.n);
              })
              .produce({}),
          ).subscribe(mainChannel);
        },
        { maxEvents: 4 },
      );

      const { events } = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* runToEnd(yield* network.run(), 'run-1');
        }).pipe(Effect.scoped),
      );

      expect(events.map((e) => e.name)).toEqual([
        'start',
        'ping',
        'ping',
        'ping',
        RunLifecycleEvent.failed,
      ]);
      expect(events.at(-1)).toMatchObject(limitFailure('events', 4));
      expect(notesSeen).toEqual([1, 2, 3]);
      // The run's agents are aborted through the usual failure path.
      expect(emitterSignal?.aborted).toBe(true);
    });

    test('transient and lifecycle events do not count', async () => {
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent, endsOn }) => {
          registerAgent(
            AgentFactory.run()
              .listensTo([start])
              .emits([tick, done])
              .logic(async ({ emit }) => {
                for (let n = 0; n < 20; n++) emit(tick.make({ n }));
                emit(done.make({}));
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(mainChannel);
          endsOn(done);
        },
        // Ticks are read with plane.subscribe.
        { maxEvents: 2, ...storeReaders },
      );

      const { outcome, events, ticks } = await Effect.runPromise(
        Effect.gen(function* () {
          // Room for every tick: the queue is only read once the run ended.
          const plane = yield* network.run({ capacity: 64 });
          const tickQueue = yield* plane.subscribe(main, (e) => e.name === 'tick');
          const result = yield* runToEnd(plane, 'run-1');
          return { ...result, ticks: yield* Queue.takeAll(tickQueue) };
        }).pipe(Effect.scoped),
      );

      expect(outcome.status).toBe('completed');
      expect([...ticks]).toHaveLength(20);
      // Transient events are delivered, never stored.
      expect(events.filter((e) => e.name === 'tick')).toHaveLength(0);
    });

    test('defaults to 1000; Infinity disables it', async () => {
      const burst = (options: AgentNetworkSetupOptions) =>
        AgentNetwork.setup(
          ({ mainChannel, registerAgent, endsOn }) => {
            registerAgent(
              AgentFactory.run()
                .listensTo([start])
                .emits([ping, done])
                .logic(async ({ emit }) => {
                  for (let n = 0; n < 1000; n++) emit(ping.make({ n }));
                  emit(done.make({}));
                })
                .produce({}),
            )
              .subscribe(mainChannel)
              .publishTo(mainChannel);
            endsOn(done);
            // Pings are only counted in the store.
          },
          { ...storeReaders, ...options },
        );

      const [capped, uncapped] = await Promise.all(
        [burst({}), burst({ maxEvents: Infinity })].map((network) =>
          Effect.runPromise(
            Effect.gen(function* () {
              return yield* runToEnd(yield* network.run(), 'run-1');
            }).pipe(Effect.scoped),
          ),
        ),
      );

      expect(DEFAULT_RUN_MAX_EVENTS).toBe(1000);
      // start + 999 pings fill the default cap; the 1000th ping is one too many.
      expect(capped?.events.filter((e) => e.name === 'ping')).toHaveLength(999);
      expect(capped?.events.at(-1)).toMatchObject(limitFailure('events', 1000));
      expect(uncapped?.outcome.status).toBe('completed');
    });

    test('publish resolves to false for an event over the limit', async () => {
      const network = AgentNetwork.setup(() => {}, { maxEvents: 1 });

      const published = await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const first = yield* plane.publish(main, start.makeBound(meta('run-1'), {}));
          const second = yield* plane.publish(main, start.makeBound(meta('run-1'), {}));
          return [first, second];
        }).pipe(Effect.scoped),
      );

      expect(published).toEqual([true, false]);
    });
  });

  describe('configuration', () => {
    test('a per-expose limit wins over the network setting', async () => {
      const { network } = pingPongNetwork({ maxDepth: 3 });
      const api = network.expose(registerSSEStream({ triggerEvents: [start], maxDepth: 6 }));

      const events = await api.createStream({ request: post() }, collect);

      expect(events).toEqual([expect.objectContaining(limitFailure('depth', 6))]);
    });

    test('per-expose limits also apply on a shared plane, for that run only', async () => {
      const { network } = pingPongNetwork({}, 8);

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const options: SseProxyConsumerOptions = {
          plane,
          maxDepth: 4,
          onRequest: ({ emitStartEvent, req }) =>
            emitStartEvent({
              runId: req.runId ?? 'unknown',
              contextId: 'ctx',
              event: start.make({}),
            }),
        };
        const limited = yield* Effect.promise(() =>
          network
            .expose(registerSSEStream(options))
            .createStream({ request: post(), runId: 'limited' }, collect),
        );
        // A run started directly on the plane keeps the network's (default) limits.
        const unlimited = yield* runToEnd(plane, 'unlimited');
        return { limited, unlimited };
      });

      const { limited, unlimited } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(limited).toEqual([expect.objectContaining(limitFailure('depth', 4))]);
      expect(unlimited.outcome.status).toBe('completed');
    });

    test('network.run() options override the network setting for runs on that plane', async () => {
      const { network } = pingPongNetwork({ maxDepth: 3 }, 4);

      const { outcome } = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* runToEnd(yield* network.run({ maxDepth: 10 }), 'run-1');
        }).pipe(Effect.scoped),
      );

      expect(outcome.status).toBe('completed');
    });

    test('the network reports its effective limits, defaults included', () => {
      expect(AgentNetwork.setup(() => {}).getRunLimits()).toEqual({
        maxDepth: 25,
        maxEvents: 1000,
        maxTokens: Infinity,
        maxCostUsd: Infinity,
      });
      expect(AgentNetwork.setup(() => {}, { maxEvents: 50, maxCostUsd: 2 }).getRunLimits()).toEqual(
        { maxDepth: 25, maxEvents: 50, maxTokens: Infinity, maxCostUsd: 2 },
      );
    });

    test('invalid limits are rejected at setup and expose time', () => {
      for (const options of [
        { maxDepth: -1 },
        { maxDepth: 1.5 },
        { maxEvents: Number.NaN },
        { maxTokens: -5 },
        { maxCostUsd: Number.NaN },
      ]) {
        expect(() => AgentNetwork.setup(() => {}, options)).toThrow(/must be/);
      }
      const network = AgentNetwork.setup(() => {});
      expect(() => network.expose(registerSSEStream({ maxEvents: 0.5 }))).toThrow(/maxEvents/);
    });
  });

  describe('types', () => {
    test('limit options are numbers on setup, run and expose options', () => {
      expectTypeOf<RunLimitOptions>().toEqualTypeOf<{
        maxDepth?: number;
        maxEvents?: number;
        maxTokens?: number;
        maxCostUsd?: number;
      }>();
      expectTypeOf<AgentNetworkSetupOptions>().toMatchTypeOf<RunLimitOptions>();
      expectTypeOf<SseProxyConsumerOptions>().toMatchTypeOf<RunLimitOptions>();
      expectTypeOf<Parameters<AgentNetwork['run']>[0]>().toMatchTypeOf<
        RunLimitOptions | undefined
      >();
    });

    test('the failed payload narrows to the exceeded limit on kind', () => {
      const payload = { error: { kind: 'agent-error' } } as RunFailedPayload;
      if (payload.error.kind === 'limit-exceeded') {
        expectTypeOf(payload.error.limit).toEqualTypeOf<'depth' | 'events' | 'tokens' | 'cost'>();
        expectTypeOf(payload.error.max).toEqualTypeOf<number>();
      } else {
        expectTypeOf(payload.error).not.toHaveProperty('limit');
      }
      expectTypeOf<RunLimitName>().toEqualTypeOf<'depth' | 'events' | 'tokens' | 'cost'>();
    });
  });
});
