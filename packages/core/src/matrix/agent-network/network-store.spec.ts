import { Effect, Queue, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { DependencyLayer } from '../dependency-layer.js';
import { registerSSEStream } from '../io/proxy-consumer.js';
import type { ExposedStream } from '../io/types.js';
import { Tool } from '../tool.js';
import { type NetworkTracer, noopNetworkTracer } from '../tracing/network-tracer.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import { EventAggregator } from './event-aggregator.js';
import type { Envelope } from './event-plane.js';
import type { EventHistory } from './history.js';
import { isRunEndEnvelope, type RunFailedEnvelope, RunLifecycleEvent } from './run-lifecycle.js';
import type {
  AgentNetworkStore,
  AgentNetworkStoreKey,
  EventPage,
  ReadContextOptions,
  StoredEvent,
} from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

const requestEvent = AgentNetworkEvent.of('request', S.Struct({ text: S.String }));
const answerEvent = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
const doneEvent = AgentNetworkEvent.of('done', S.Struct({}));
const tokenEvent = AgentNetworkEvent.of('token', S.Struct({ delta: S.String }), {
  transient: true,
});

const anonymous = (contextId: string): AgentNetworkStoreKey => ({
  namespace: 'anonymous',
  contextId,
});

/** The in-memory store, recording every append (key and event name). */
function recordingStore(): {
  store: AgentNetworkStore;
  appended: Array<{ key: AgentNetworkStoreKey; name: string }>;
} {
  const inner = createInMemoryNetworkStore();
  const appended: Array<{ key: AgentNetworkStoreKey; name: string }> = [];
  const store: AgentNetworkStore = {
    ...inner,
    append: async (key, event) => {
      appended.push({ key, name: event.name });
      await inner.append(key, event);
    },
  };
  return { store, appended };
}

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

function post(payload: unknown): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** request -> answer agent on main -> client; the answer completes the run. */
function echoNetwork(options?: AgentNetworkSetupOptions) {
  return AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    const agent = AgentFactory.run()
      .listensTo([requestEvent])
      .emits([answerEvent])
      .logic(async ({ triggerEvent, emit }) => {
        emit(answerEvent.make({ text: `echo ${triggerEvent.payload.text}` }));
      })
      .produce({});
    registerAgent(agent).subscribe(mainChannel).publishTo(client);
    endsOn(answerEvent);
  }, options);
}

describe('network store', () => {
  describe('store option', () => {
    test('network.run() writes to the store passed at setup', async () => {
      const { store, appended } = recordingStore();
      const network = echoNetwork({ store });
      expect(network.getStore()).toBe(store);

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
        yield* plane.publish(ChannelNameOf(network, 'main'), {
          name: 'request',
          meta: { runId: 'run-1', contextId: 'ctx-1' },
          payload: { text: 'hi' },
        });
        yield* takeUntilRunEnd(client);
      });
      await Effect.runPromise(program.pipe(Effect.scoped));

      expect(appended).toEqual([
        { key: anonymous('ctx-1'), name: 'request' },
        { key: anonymous('ctx-1'), name: 'answer' },
        { key: anonymous('ctx-1'), name: RunLifecycleEvent.completed },
      ]);
    });

    test('expose() writes to the store passed at setup', async () => {
      const { store, appended } = recordingStore();
      const network = echoNetwork({ store });
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream(
        { request: post({ text: 'hi' }), contextId: 'ctx-2', runId: 'run-2' },
        collect,
      );

      expect(events.map((e) => e.name)).toEqual(['answer', RunLifecycleEvent.completed]);
      expect(appended).toEqual([
        { key: anonymous('ctx-2'), name: 'request' },
        { key: anonymous('ctx-2'), name: 'answer' },
        { key: anonymous('ctx-2'), name: RunLifecycleEvent.completed },
      ]);
      const stored: readonly StoredEvent[] = await store.readRun(anonymous('ctx-2'), 'run-2');
      expect(stored.map((e) => e.name)).toEqual(['request', 'answer', RunLifecycleEvent.completed]);
    });

    test('the builder passes the store option on', () => {
      const store = createInMemoryNetworkStore();
      const configLayer = DependencyLayer.of({
        name: 'Config',
        config: S.Struct({ apiKey: S.String }),
      }).define<{ apiKey: string }>();
      const network = AgentNetwork.dependsOn(configLayer).setup(() => {}, { store });

      expect(network.getStore()).toBe(store);
    });

    test('each network defaults to its own in-memory store', () => {
      const first = AgentNetwork.setup(() => {});
      const second = AgentNetwork.setup(() => {});

      expect(first.getStore()).not.toBe(second.getStore());
      expect(typeof first.getStore().append).toBe('function');
    });
  });
  describe('ctx.history', () => {
    const storedEvent = (contextId: string, runId: string, name: string): StoredEvent => ({
      name,
      meta: { runId, contextId },
      payload: { text: name },
    });

    /** Runs `request` in `meta` on a network whose agent reports what `read` returns. */
    async function readHistoryInRun<T>(
      read: (history: EventHistory) => Promise<T>,
      options: {
        store?: AgentNetworkStore;
        meta?: { runId: string; contextId: string; principalId?: string };
      } = {},
    ): Promise<T> {
      let result: { value: T } | undefined;
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent, endsOn }) => {
          const client = createChannel('client');
          const agent = AgentFactory.run()
            .listensTo([requestEvent])
            .emits([answerEvent])
            .logic(async ({ history, emit }) => {
              expectTypeOf(history).toEqualTypeOf<EventHistory>();
              result = { value: await read(history) };
              emit(answerEvent.make({ text: 'done' }));
            })
            .produce({});
          registerAgent(agent).subscribe(mainChannel).publishTo(client);
          endsOn(answerEvent);
        },
        { store: options.store },
      );
      const meta = options.meta ?? { runId: 'run-1', contextId: 'ctx' };
      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
          yield* plane.publish(ChannelNameOf(network, 'main'), {
            name: 'request',
            meta,
            payload: { text: 'now' },
          });
          yield* takeUntilRunEnd(client);
        }).pipe(Effect.scoped),
      );
      if (!result) throw new Error('agent did not run');
      return result.value;
    }

    test('run() returns the durable events of the run so far, trigger included', async () => {
      const seen: string[][] = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent, endsOn }) => {
          const client = createChannel('client');
          const asker = AgentFactory.run()
            .listensTo([requestEvent])
            .emits([answerEvent])
            .logic(async ({ history, emit }) => {
              seen.push((await history.run()).map((e) => e.name));
              emit(answerEvent.make({ text: 'a' }));
            })
            .produce({});
          const reader = AgentFactory.run()
            .listensTo([answerEvent])
            .emits([doneEvent])
            .logic(async ({ history, emit }) => {
              seen.push((await history.run()).map((e) => e.name));
              emit(doneEvent.make({}));
            })
            .produce({});
          registerAgent(asker).subscribe(mainChannel).publishTo(mainChannel);
          registerAgent(reader).subscribe(mainChannel).publishTo(client);
          endsOn(doneEvent);
        },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
          // An earlier run of the same context is not part of this run's history.
          yield* plane.publish(ChannelNameOf(network, 'client'), {
            name: 'earlier',
            meta: { runId: 'run-0', contextId: 'ctx' },
            payload: {},
          });
          yield* plane.publish(ChannelNameOf(network, 'main'), {
            name: 'request',
            meta: { runId: 'run-1', contextId: 'ctx' },
            payload: { text: 'q' },
          });
          yield* takeUntilRunEnd(client);
        }).pipe(Effect.scoped),
      );

      expect(seen).toEqual([['request'], ['request', 'answer']]);
    });

    test('context() pages back through earlier runs of the context, oldest first', async () => {
      const store = createInMemoryNetworkStore();
      for (const name of ['e1', 'e2', 'e3', 'e4', 'e5']) {
        await store.append(anonymous('ctx'), storedEvent('ctx', 'run-0', name));
      }

      const pages = await readHistoryInRun(
        async (history) => {
          const newest = await history.context({ limit: 3 });
          const older = await history.context({ limit: 3, before: newest.cursor });
          const all = await history.context();
          return { newest, older, all };
        },
        { store },
      );

      expect(pages.newest.events.map((e) => e.name)).toEqual(['e4', 'e5', 'request']);
      expect(pages.newest.cursor).toEqual(expect.any(String));
      expect(pages.older.events.map((e) => e.name)).toEqual(['e1', 'e2', 'e3']);
      expect(pages.older.cursor).toBeUndefined();
      expect(pages.all.events.map((e) => e.name)).toEqual([
        'e1',
        'e2',
        'e3',
        'e4',
        'e5',
        'request',
      ]);
    });

    test("is scoped to the run's principal namespace", async () => {
      const store = createInMemoryNetworkStore();
      await store.append(
        { namespace: 'principal:alice', contextId: 'ctx' },
        storedEvent('ctx', 'run-0', 'alice-secret'),
      );
      await store.append(anonymous('ctx'), storedEvent('ctx', 'run-0', 'anonymous-note'));

      const read = async (history: EventHistory) => ({
        context: (await history.context()).events.map((e) => e.name),
        run: (await history.run()).map((e) => e.name),
      });
      const asBob = await readHistoryInRun(read, {
        store,
        meta: { runId: 'run-bob', contextId: 'ctx', principalId: 'bob' },
      });
      const asAlice = await readHistoryInRun(read, {
        store,
        meta: { runId: 'run-alice', contextId: 'ctx', principalId: 'alice' },
      });
      const asAnonymous = await readHistoryInRun(read, {
        store,
        meta: { runId: 'run-anon', contextId: 'ctx' },
      });

      expect(asBob).toEqual({ context: ['request'], run: ['request'] });
      expect(asAlice).toEqual({ context: ['alice-secret', 'request'], run: ['request'] });
      expect(asAnonymous).toEqual({ context: ['anonymous-note', 'request'], run: ['request'] });
    });

    test.each([0, -1, 2.5, Number.NaN])('context() rejects limit %s', async (limit) => {
      const error = await readHistoryInRun((history) =>
        history.context({ limit }).then(
          () => undefined,
          (e: unknown) => e,
        ),
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/limit/);
    });

    test('aggregators read history in emitWhen and mapToEmit', async () => {
      const calls: Array<{ hook: string; run: string[] }> = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAggregator, endsOn }) => {
          const client = createChannel('client');
          const aggregator = EventAggregator.listensTo([requestEvent])
            .emits([answerEvent])
            .emitWhen(async ({ history }) => {
              expectTypeOf(history).toEqualTypeOf<EventHistory>();
              calls.push({ hook: 'emitWhen', run: (await history.run()).map((e) => e.name) });
              return true;
            })
            .mapToEmit(async ({ history, emit }) => {
              expectTypeOf(history).toEqualTypeOf<EventHistory>();
              const page = await history.context({ limit: 1 });
              calls.push({ hook: 'mapToEmit', run: page.events.map((e) => e.name) });
              emit(answerEvent.make({ text: 'summary' }));
            });
          registerAggregator(aggregator).subscribe(mainChannel).publishTo(client);
          endsOn(answerEvent);
        },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
          yield* plane.publish(ChannelNameOf(network, 'main'), {
            name: 'request',
            meta: { runId: 'run-1', contextId: 'ctx' },
            payload: { text: 'q' },
          });
          yield* takeUntilRunEnd(client);
        }).pipe(Effect.scoped),
      );

      expect(calls).toEqual([
        { hook: 'emitWhen', run: ['request'] },
        { hook: 'mapToEmit', run: ['request'] },
      ]);
    });

    test('plane.history() reads the same history outside agents', async () => {
      const network = AgentNetwork.setup(() => {});

      const { run, context, anonymousRun } = await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          for (const [runId, name] of [
            ['run-1', 'a'],
            ['run-2', 'b'],
            ['run-1', 'c'],
          ]) {
            yield* plane.publish(ChannelNameOf(network, 'main'), {
              name,
              meta: { runId, contextId: 'ctx', principalId: 'alice' },
              payload: {},
            });
          }
          const history = plane.history({ runId: 'run-1', contextId: 'ctx', principalId: 'alice' });
          const anonymousHistory = plane.history({ runId: 'run-1', contextId: 'ctx' });
          return {
            run: yield* Effect.promise(() => history.run()),
            context: yield* Effect.promise(() => history.context()),
            anonymousRun: yield* Effect.promise(() => anonymousHistory.run()),
          };
        }).pipe(Effect.scoped),
      );

      expect(run.map((e) => e.name)).toEqual(['a', 'c']);
      expect(context.events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
      expect(anonymousRun).toEqual([]);
    });

    test('a standalone agent gets an empty history', async () => {
      let read: { run: readonly StoredEvent[]; context: EventPage } | undefined;
      const agent = AgentFactory.run()
        .listensTo([requestEvent])
        .logic(async ({ history }) => {
          read = { run: await history.run(), context: await history.context({ limit: 5 }) };
        })
        .produce({});

      await agent.invoke({
        triggerEvent: requestEvent.makeBound({ runId: 'r', contextId: 'c' }, { text: 'x' }),
      });

      expect(read).toEqual({ run: [], context: { events: [] } });
    });

    test('types', () => {
      expectTypeOf<EventHistory['run']>().toEqualTypeOf<() => Promise<readonly StoredEvent[]>>();
      expectTypeOf<EventHistory['context']>().toEqualTypeOf<
        (options?: ReadContextOptions) => Promise<EventPage>
      >();
      AgentFactory.run()
        .listensTo([requestEvent])
        .logic(async (ctx) => {
          expectTypeOf(ctx).not.toHaveProperty('runEvents');
          expectTypeOf(ctx).not.toHaveProperty('contextEvents');
          expectTypeOf(ctx.history).toEqualTypeOf<EventHistory>();
        });
    });
  });
  describe('transient events', () => {
    /** Collects what the tracer saw published, by event name. */
    function publishedNames(): { tracer: NetworkTracer; names: string[] } {
      const names: string[] = [];
      return {
        names,
        tracer: {
          ...noopNetworkTracer,
          onEventPublish: async ({ name }) => {
            names.push(name);
          },
        },
      };
    }

    test('are streamed and traced but never stored nor in history', async () => {
      const { store, appended } = recordingStore();
      const { tracer, names: traced } = publishedNames();
      let historyOfReader: string[] = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent, endsOn }) => {
          const client = createChannel('client');
          const writer = AgentFactory.run()
            .listensTo([requestEvent])
            .emits([tokenEvent, answerEvent])
            .logic(async ({ emit }) => {
              emit(tokenEvent.make({ delta: 'he' }));
              emit(tokenEvent.make({ delta: 'llo' }));
              emit(answerEvent.make({ text: 'hello' }));
            })
            .produce({});
          const reader = AgentFactory.run()
            .listensTo([answerEvent])
            .emits([doneEvent])
            .logic(async ({ history, emit }) => {
              historyOfReader = (await history.run()).map((e) => e.name);
              emit(doneEvent.make({}));
            })
            .produce({});
          registerAgent(writer).subscribe(mainChannel).publishTo(client).publishTo(mainChannel);
          registerAgent(reader).subscribe(mainChannel).publishTo(client);
          endsOn(doneEvent);
        },
        { store, networkTracer: tracer },
      );

      const streamed = await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
          yield* plane.publish(ChannelNameOf(network, 'main'), {
            name: 'request',
            meta: { runId: 'run-1', contextId: 'ctx' },
            payload: { text: 'q' },
          });
          return yield* takeUntilRunEnd(client);
        }).pipe(Effect.scoped),
      );

      expect(streamed.map((e) => e.name)).toEqual([
        'token',
        'token',
        'answer',
        'done',
        RunLifecycleEvent.completed,
      ]);
      expect(traced.filter((name) => name === 'token')).toHaveLength(4);
      expect(appended.map((a) => a.name)).toEqual([
        'request',
        'answer',
        'done',
        RunLifecycleEvent.completed,
      ]);
      expect(historyOfReader).toEqual(['request', 'answer']);
      const context = await store.readContext(anonymous('ctx'));
      expect(context.events.some((e) => e.name === 'token')).toBe(false);
    });

    test('transient events emitted only through a tool are transient too', async () => {
      const { store, appended } = recordingStore();
      const { tracer, names: traced } = publishedNames();
      const typeOut = Tool.of({ name: 'typeOut', description: 'Streams text as tokens' })
        .emits([tokenEvent])
        .input(S.Struct({ text: S.String }))
        .output(S.Struct({ ok: S.Boolean }))
        .define(({ input, emit }) => {
          emit(tokenEvent.make({ delta: input.text }));
          return { ok: true };
        });
      const writer = AgentFactory.run()
        .listensTo([requestEvent])
        .emits([answerEvent])
        .tools(typeOut)
        .logic(async ({ emit, tools }) => {
          await tools.toTools()[0]?.execute({ text: 'he' });
          emit(answerEvent.make({ text: 'hello' }));
        })
        .produce({});
      // The agent's own `emits` do not name the event: only its tool does.
      expect(writer.getTransientEvents()).toEqual(['token']);

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent, endsOn }) => {
          const client = createChannel('client');
          registerAgent(writer).subscribe(mainChannel).publishTo(client).publishTo(mainChannel);
          endsOn(answerEvent);
        },
        { store, networkTracer: tracer },
      );

      const streamed = await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
          yield* plane.publish(ChannelNameOf(network, 'main'), {
            name: 'request',
            meta: { runId: 'run-1', contextId: 'ctx' },
            payload: { text: 'q' },
          });
          return yield* takeUntilRunEnd(client);
        }).pipe(Effect.scoped),
      );

      expect(streamed.map((e) => e.name)).toEqual(['token', 'answer', RunLifecycleEvent.completed]);
      expect(traced).toContain('token');
      expect(appended.map((a) => a.name)).toEqual([
        'request',
        'answer',
        RunLifecycleEvent.completed,
      ]);
    });

    test('an aggregator declares the transient events it emits', async () => {
      const { store, appended } = recordingStore();
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAggregator, endsOn }) => {
          const client = createChannel('client');
          const aggregator = EventAggregator.listensTo([requestEvent])
            .emits([tokenEvent, answerEvent])
            .mapToEmit(({ emit }) => {
              emit(tokenEvent.make({ delta: 'x' }));
              emit(answerEvent.make({ text: 'x' }));
            });
          registerAggregator(aggregator).subscribe(mainChannel).publishTo(client);
          endsOn(answerEvent);
        },
        { store },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
          yield* plane.publish(ChannelNameOf(network, 'main'), {
            name: 'request',
            meta: { runId: 'run-1', contextId: 'ctx' },
            payload: { text: 'q' },
          });
          yield* takeUntilRunEnd(client);
        }).pipe(Effect.scoped),
      );

      expect(appended.map((a) => a.name)).toEqual([
        'request',
        'answer',
        RunLifecycleEvent.completed,
      ]);
    });
  });
  describe('store write failures', () => {
    /** The in-memory store, with appends of `failing` events rejecting `failures` times each. */
    function failingStore(failing: (event: StoredEvent) => boolean, failures: number) {
      const inner = createInMemoryNetworkStore();
      const attempts: string[] = [];
      const failed = new Map<string, number>();
      const store: AgentNetworkStore = {
        ...inner,
        append: async (key, event) => {
          attempts.push(event.name);
          const id = event.meta.eventId ?? event.name;
          const count = failed.get(id) ?? 0;
          if (failing(event) && count < failures) {
            failed.set(id, count + 1);
            throw new Error('connect ECONNREFUSED 10.0.0.7:5432');
          }
          await inner.append(key, event);
        },
      };
      return { store, attempts };
    }

    /** request -> answer -> (reader) done; the reader records what it was handed. */
    function answerReaderNetwork(options: AgentNetworkSetupOptions) {
      const delivered: string[] = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
          const client = createChannel('client').proxy(proxy.sse());
          const writer = AgentFactory.run()
            .listensTo([requestEvent])
            .emits([answerEvent])
            .logic(async ({ triggerEvent, emit }) => {
              delivered.push(triggerEvent.name);
              emit(answerEvent.make({ text: 'a' }));
            })
            .produce({});
          const reader = AgentFactory.run()
            .listensTo([answerEvent])
            .emits([doneEvent])
            .logic(async ({ triggerEvent, emit }) => {
              delivered.push(triggerEvent.name);
              emit(doneEvent.make({}));
            })
            .produce({});
          registerAgent(writer).subscribe(mainChannel).publishTo(mainChannel).publishTo(client);
          registerAgent(reader).subscribe(mainChannel).publishTo(client);
          endsOn(doneEvent);
        },
        options,
      );
      return { network, delivered };
    }

    function runRequest(network: AgentNetwork) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const client = yield* plane.subscribe(ChannelNameOf(network, 'client'));
          yield* plane.publish(ChannelNameOf(network, 'main'), {
            name: 'request',
            meta: { runId: 'run-1', contextId: 'ctx' },
            payload: { text: 'q' },
          });
          return yield* takeUntilRunEnd(client);
        }).pipe(Effect.scoped),
      );
    }

    test('a write that fails twice is retried and the run goes on', async () => {
      const { store, attempts } = failingStore((e) => e.name === 'answer', 2);
      const { network, delivered } = answerReaderNetwork({ store });

      const streamed = await runRequest(network);

      expect(attempts.filter((name) => name === 'answer')).toHaveLength(3);
      expect(delivered).toEqual(['request', 'answer']);
      expect(streamed.at(-1)?.name).toBe(RunLifecycleEvent.completed);
      expect((await store.readRun(anonymous('ctx'), 'run-1')).map((e) => e.name)).toEqual([
        'request',
        'answer',
        'done',
        RunLifecycleEvent.completed,
      ]);
    });

    test('a write that keeps failing fails the run with kind store-error; the event is not delivered', async () => {
      const { store, attempts } = failingStore(
        (e) => e.name === 'answer',
        Number.POSITIVE_INFINITY,
      );
      const { network, delivered } = answerReaderNetwork({ store });

      const streamed = await runRequest(network);

      expect(attempts.filter((name) => name === 'answer')).toHaveLength(3);
      // Neither the reader agent nor the client got the event that was not stored.
      expect(delivered).toEqual(['request']);
      expect(streamed.map((e) => e.name)).toEqual([RunLifecycleEvent.failed]);
      const failed = streamed[0] as RunFailedEnvelope;
      expect(failed.payload.error).toEqual({
        name: 'NetworkStoreError',
        message: 'Could not write event "answer" to the network store',
        kind: 'store-error',
      });
      // The store's own error stays on the server.
      expect(JSON.stringify(failed)).not.toContain('ECONNREFUSED');
      expect((await store.readRun(anonymous('ctx'), 'run-1')).map((e) => e.name)).toEqual([
        'request',
        RunLifecycleEvent.failed,
      ]);
    });

    test('through expose: a failing start event write fails the run before any agent runs', async () => {
      const { store } = failingStore(() => true, Number.POSITIVE_INFINITY);
      const { tracer, calls } = runEndTracer();
      const error = vi.fn();
      const { network, delivered } = answerReaderNetwork({
        store,
        networkTracer: tracer,
        logger: { warn: vi.fn(), error },
      });
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream(
        { request: post({ text: 'hi' }), contextId: 'ctx', runId: 'run-x' },
        collect,
      );

      expect(delivered).toEqual([]);
      // The run-end event still reaches the client even though the store is down.
      expect(events.map((e) => e.name)).toEqual([RunLifecycleEvent.failed]);
      expect((events[0] as RunFailedEnvelope).payload.error.kind).toBe('store-error');
      expect(calls).toEqual([
        {
          status: 'error',
          error: expect.objectContaining({
            name: 'NetworkStoreError',
            cause: expect.objectContaining({ message: 'connect ECONNREFUSED 10.0.0.7:5432' }),
          }),
        },
      ]);
      // The run-end event that could not be stored is logged, not lost silently.
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`could not store ${RunLifecycleEvent.failed} of run run-x`),
        expect.objectContaining({ message: 'connect ECONNREFUSED 10.0.0.7:5432' }),
      );
    });
  });
  describe('write ordering', () => {
    test('writes of one run are applied in publish order, even when later writes are faster', async () => {
      const inner = createInMemoryNetworkStore();
      const committed: string[] = [];
      let calls = 0;
      const store: AgentNetworkStore = {
        ...inner,
        append: async (key, event) => {
          // Each write is faster than the one before it.
          const delay = 30 - 5 * calls++;
          await new Promise((resolve) => setTimeout(resolve, Math.max(delay, 0)));
          committed.push(event.name);
          await inner.append(key, event);
        },
      };
      const network = AgentNetwork.setup(() => {}, { store });
      const names = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'];

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          // Concurrent publishers into one run, started in order.
          yield* Effect.forEach(
            names,
            (name) =>
              plane.publish(ChannelNameOf(network, 'main'), {
                name,
                meta: { runId: 'run-1', contextId: 'ctx' },
                payload: {},
              }),
            { concurrency: 'unbounded', discard: true },
          );
        }).pipe(Effect.scoped),
      );

      expect(committed).toEqual(names);
      expect((await store.readRun(anonymous('ctx'), 'run-1')).map((e) => e.name)).toEqual(names);
    });

    test('a slow write in one run does not hold back other runs', async () => {
      const inner = createInMemoryNetworkStore();
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store: AgentNetworkStore = {
        ...inner,
        append: async (key, event) => {
          if (event.meta.runId === 'slow') await gate;
          await inner.append(key, event);
        },
      };
      const network = AgentNetwork.setup(() => {}, { store });

      const order = await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const done: string[] = [];
          const publish = (runId: string) =>
            plane
              .publish(ChannelNameOf(network, 'main'), {
                name: 'e',
                meta: { runId, contextId: runId },
                payload: {},
              })
              .pipe(Effect.tap(() => Effect.sync(() => done.push(runId))));
          const slow = yield* Effect.fork(publish('slow'));
          yield* publish('fast');
          release();
          yield* slow.await;
          return done;
        }).pipe(Effect.scoped),
      );

      expect(order).toEqual(['fast', 'slow']);
    });
  });
});

/** A tracer recording `onRunEnd` (status and error); everything else is a no-op. */
function runEndTracer(): {
  tracer: NetworkTracer;
  calls: Array<{ status: string | undefined; error: Error | undefined }>;
} {
  const calls: Array<{ status: string | undefined; error: Error | undefined }> = [];
  return {
    calls,
    tracer: {
      ...noopNetworkTracer,
      onRunEnd: async (_meta, error, options) => {
        calls.push({ status: options?.status, error });
      },
    },
  };
}

/** Takes envelopes until a run-end event; returns them all. */
function takeUntilRunEnd(queue: Queue.Dequeue<Envelope>): Effect.Effect<Envelope[]> {
  return Effect.gen(function* () {
    const out: Envelope[] = [];
    while (true) {
      const envelope = yield* Queue.take(queue);
      out.push(envelope);
      if (isRunEndEnvelope(envelope)) return out;
    }
  });
}

function ChannelNameOf(network: AgentNetwork, name: string) {
  const channel = network.getChannels().get(name);
  if (!channel) throw new Error(`Expected channel ${name} to exist`);
  return channel.name;
}
