import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { ContextFold } from '../context/context-fold.js';
import type { FoldCacheOptions } from '../context/fold-cache.js';
import { ChannelName } from '../identifiers/channel-name.js';
import type { NetworkMetric } from '../metrics.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network.js';
import { AgentNetworkEvent, type EventMeta } from './agent-network-event.js';
import { EventAggregator } from './event-aggregator.js';
import { type EventPlane, inspectEventPlane } from './event-plane.js';
import { AgentAbortedError } from './run-lifecycle.js';
import type { AgentNetworkStore, StoredEvent } from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const Reply = AgentNetworkEvent.of('reply', S.Struct({ text: S.String }));
const CompactionRequested = AgentNetworkEvent.of('compaction-requested', S.Struct({}));
const Compacted = AgentNetworkEvent.of('compacted', S.Struct({ summary: S.String }));

type Lines = readonly string[];

/** A conversation fold; `applied` records the id of every event a handler folded. */
const makeConversation = (applied: string[]) =>
  ContextFold.of('conversation', { version: 1 })
    .over([UserPrompt, Reply, Compacted])
    .initial((): Lines => [])
    .on(UserPrompt, (lines, { payload, meta }) => {
      applied.push(meta.eventId ?? '?');
      return [...lines, `user: ${payload.text}`];
    })
    .on(Reply, (lines, { payload, meta }) => {
      applied.push(meta.eventId ?? '?');
      return [...lines, `model: ${payload.text}`];
    })
    .checkpointOn(Compacted, ({ payload, meta }) => {
      applied.push(meta.eventId ?? '?');
      return [`summary: ${payload.summary}`];
    });

const makeReplies = () =>
  ContextFold.of('replies', { version: 1 })
    .scope('run')
    .over([Reply])
    .initial(() => 0)
    .on(Reply, (count) => count + 1);

const quietLogger = () => ({ warn: vi.fn(), error: vi.fn() });

const meta = (runId: string, contextId = 'ctx-1'): EventMeta => ({ runId, contextId });

/** Publishes a prompt in a new run and waits until the run has ended and released its state. */
const prompt = (plane: EventPlane, text: string, runMeta: EventMeta) =>
  Effect.gen(function* () {
    yield* plane.publish(ChannelName('main'), {
      name: 'user-prompt',
      meta: runMeta,
      payload: { text },
    });
    yield* plane.awaitRunEnd(runMeta.runId);
    while (inspectEventPlane(plane).activeRuns > 0) yield* Effect.sleep('1 millis');
  });

/** A model agent that reads the conversation and replies; the reply ends the run. */
const chatNetwork = (
  options: { applied?: string[]; reads?: unknown[]; setup?: AgentNetworkSetupOptions } = {},
) => {
  const Conversation = makeConversation(options.applied ?? []);
  return AgentNetwork.setup(
    ({ mainChannel, registerAgent, endsOn }) => {
      const model = AgentFactory.run()
        .listensTo([UserPrompt])
        .emits([Reply])
        .folds([Conversation])
        .logic(async ({ folds, triggerEvent, emit }) => {
          const lines = await folds.conversation();
          options.reads?.push(lines);
          emit(Reply.make({ text: `re ${triggerEvent.payload.text}` }));
        })
        .produce({});
      registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
      endsOn(Reply);
    },
    { logger: quietLogger(), ...options.setup },
  );
};

describe('folds in a network', () => {
  test('reads are cached across runs: every event is folded once, trigger included', async () => {
    const applied: string[] = [];
    const reads: unknown[] = [];
    const store = createInMemoryNetworkStore();
    const readContext = vi.spyOn(store, 'readContext');
    const network = chatNetwork({ applied, reads, setup: { store } });

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* prompt(plane, 'a', meta('run-1'));
        yield* prompt(plane, 'b', meta('run-2'));
        yield* prompt(plane, 'c', meta('run-3'));
      }).pipe(Effect.scoped),
    );

    expect(reads).toEqual([
      ['user: a'],
      ['user: a', 'model: re a', 'user: b'],
      ['user: a', 'model: re a', 'user: b', 'model: re b', 'user: c'],
    ]);
    expect(applied).toHaveLength(5);
    expect(new Set(applied).size).toBe(5);
    // Only the first read was cold; the later ones read after a cursor.
    const afters = readContext.mock.calls.map(([, options]) => options?.after);
    expect(afters[0]).toBeUndefined();
    expect(afters.slice(1).every((after) => after !== undefined)).toBe(true);
  });

  test('a re-read after emitAndAwait sees the checkpoint the other agent published', async () => {
    const applied: string[] = [];
    const Conversation = makeConversation(applied);
    const seen: Record<string, unknown> = {};
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent, endsOn }) => {
        const model = AgentFactory.run()
          .listensTo([UserPrompt])
          .emits([Reply, CompactionRequested])
          .folds([Conversation])
          .logic(async ({ folds, emit, emitAndAwait }) => {
            seen.before = await folds.conversation();
            await emitAndAwait(CompactionRequested.make({}), (reply) => reply.name === 'compacted');
            seen.after = await folds.conversation();
            emit(Reply.make({ text: 'ok' }));
          })
          .produce({});
        const compactor = AgentFactory.run()
          .listensTo([CompactionRequested])
          .emits([Compacted], { reply: true })
          .folds([Conversation])
          .logic(async ({ folds, emit }) => {
            const lines = await folds.conversation();
            emit(Compacted.make({ summary: `${lines.length} lines` }));
          })
          .produce({});
        registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
        registerAgent(compactor).subscribe(mainChannel).publishTo(mainChannel);
        endsOn(Reply);
      },
      { logger: quietLogger() },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* prompt(plane, 'hi', meta('run-1'));
      }).pipe(Effect.scoped),
    );

    expect(seen).toEqual({ before: ['user: hi'], after: ['summary: 1 lines'] });
    // The prompt and the checkpoint, each folded once across both agents' reads.
    expect(applied).toHaveLength(2);
  });

  test('agents reading the same fold at once never fold an event twice', async () => {
    const applied: string[] = [];
    const Conversation = makeConversation(applied);
    const reads: Lines[] = [];
    // Three agents read on every prompt, each twice at once; nothing ends the runs, so no read
    // is cut short.
    const reader = () =>
      AgentFactory.run()
        .listensTo([UserPrompt])
        .folds([Conversation])
        .logic(async ({ folds }) => {
          reads.push(...(await Promise.all([folds.conversation(), folds.conversation()])));
        })
        .produce({});
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent }) => {
        for (let i = 0; i < 3; i++) registerAgent(reader()).subscribe(mainChannel);
      },
      { logger: quietLogger() },
    );
    const publish = (plane: EventPlane, text: string, runId: string) =>
      plane.publish(ChannelName('main'), {
        name: 'user-prompt',
        meta: meta(runId),
        payload: { text },
      });
    const readsReach = (count: number) =>
      Effect.gen(function* () {
        while (reads.length < count) yield* Effect.sleep('1 millis');
      });

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* publish(plane, 'a', 'run-1');
        yield* readsReach(6);
        yield* publish(plane, 'b', 'run-2');
        yield* readsReach(12);
      }).pipe(Effect.scoped),
    );

    expect(reads.slice(0, 6)).toEqual(Array(6).fill(['user: a']));
    expect(reads.slice(6)).toEqual(Array(6).fill(['user: a', 'user: b']));
    // 12 reads, 2 events: each folded once.
    expect(applied).toHaveLength(2);
    expect(new Set(applied).size).toBe(2);
  });

  test('a cold read starts at the newest checkpoint in the store', async () => {
    const applied: string[] = [];
    const reads: unknown[] = [];
    const store = createInMemoryNetworkStore();
    const key = { namespace: 'anonymous', contextId: 'ctx-1' };
    const old = meta('run-0');
    await store.append(key, UserPrompt.makeBound({ ...old, eventId: 'p0' }, { text: 'old' }));
    await store.append(key, Compacted.makeBound({ ...old, eventId: 'c0' }, { summary: 'earlier' }));
    await store.append(key, Reply.makeBound({ ...old, eventId: 'r0' }, { text: 'after summary' }));
    const readLatest = vi.spyOn(store as Required<AgentNetworkStore>, 'readLatest');
    const network = chatNetwork({ applied, reads, setup: { store } });

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* prompt(plane, 'new', meta('run-1'));
      }).pipe(Effect.scoped),
    );

    expect(readLatest).toHaveBeenCalledWith(key, ['compacted']);
    expect(reads).toEqual([['summary: earlier', 'model: after summary', 'user: new']]);
    expect(applied.slice(0, 2)).toEqual(['c0', 'r0']);
    expect(applied).not.toContain('p0');
  });

  test('a context deleted through the store is rebuilt, not continued', async () => {
    const reads: unknown[] = [];
    const network = chatNetwork({ reads });

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* prompt(plane, 'secret', meta('run-1'));
        yield* Effect.promise(async () =>
          network.getStore().deleteContext?.({ namespace: 'anonymous', contextId: 'ctx-1' }),
        );
        yield* prompt(plane, 'fresh', meta('run-2'));
      }).pipe(Effect.scoped),
    );

    expect(reads).toEqual([['user: secret'], ['user: fresh']]);
  });

  test('run-scoped state is dropped when its run ends; context state is kept', async () => {
    const counts: number[] = [];
    const Replies = makeReplies();
    const Conversation = makeConversation([]);
    const ReplyReady = AgentNetworkEvent.of('reply-ready', S.Struct({}));
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent, endsOn }) => {
        const model = AgentFactory.run()
          .listensTo([UserPrompt])
          .emits([Reply])
          .logic(async ({ emit }) => emit(Reply.make({ text: 'one' })))
          .produce({});
        const counter = AgentFactory.run()
          .listensTo([Reply])
          .emits([ReplyReady])
          .folds([Replies, Conversation])
          .logic(async ({ folds, emit }) => {
            counts.push(await folds.replies());
            await folds.conversation();
            emit(ReplyReady.make({}));
          })
          .produce({});
        registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
        registerAgent(counter).subscribe(mainChannel).publishTo(mainChannel);
        endsOn(ReplyReady);
      },
      { logger: quietLogger() },
    );

    const stats = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* prompt(plane, 'a', meta('run-1'));
        yield* prompt(plane, 'b', meta('run-2'));
        return inspectEventPlane(plane);
      }).pipe(Effect.scoped),
    );

    // Each run counts its own replies.
    expect(counts).toEqual([1, 1]);
    expect(stats.foldStates).toBe(1);
  });

  test('aggregators read through the cache too', async () => {
    const applied: string[] = [];
    const Conversation = makeConversation(applied);
    const sizes: number[] = [];
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent, registerAggregator, endsOn }) => {
        registerAgent(
          AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([CompactionRequested])
            .logic(async ({ emit }) => emit(CompactionRequested.make({})))
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(mainChannel);
        registerAggregator(
          EventAggregator.listensTo([CompactionRequested])
            .emits([Reply])
            .folds([Conversation])
            .emitWhen(async ({ folds }) => (await folds.conversation()).length > 0)
            .mapToEmit(async ({ folds, emit }) => {
              sizes.push((await folds.conversation()).length);
              emit(Reply.make({ text: 'r' }));
            }),
        )
          .subscribe(mainChannel)
          .publishTo(mainChannel);
        endsOn(Reply);
      },
      { logger: quietLogger() },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* prompt(plane, 'a', meta('run-1'));
        yield* prompt(plane, 'b', meta('run-2'));
      }).pipe(Effect.scoped),
    );

    expect(sizes).toEqual([1, 3]);
    expect(new Set(applied).size).toBe(applied.length);
  });

  describe('read-your-writes: a read includes what the invocation emitted before it', () => {
    const Step = AgentNetworkEvent.of('step', S.Struct({ n: S.Number }));
    const Done = AgentNetworkEvent.of('done', S.Struct({}));
    const Progress = AgentNetworkEvent.of('progress', S.Struct({}), { transient: true });
    const Ask = AgentNetworkEvent.of('ask', S.Struct({}));
    const Answer = AgentNetworkEvent.of('answer', S.Struct({}));
    const Steps = ContextFold.of('steps', { version: 1 })
      .over([UserPrompt, Step])
      .initial((): Lines => [])
      .on(UserPrompt, (lines, { payload }) => [...lines, `user: ${payload.text}`])
      .on(Step, (lines, { payload }) => [...lines, `step ${payload.n}`]);
    const StepCount = ContextFold.of('stepCount', { version: 1 })
      .scope('run')
      .over([Step, Ask])
      .initial(() => 0)
      .on(Step, (count) => count + 1)
      .on(Ask, (count) => count + 1);

    /**
     * The in-memory store, its appends delayed (so an emit is stored well after `emit()`
     * returns) or held by `hold` (resolved: stored, rejected: the append fails).
     */
    const slowStore = (
      hold: (event: StoredEvent) => Promise<void> | undefined = () =>
        new Promise((resolve) => setTimeout(resolve, 5)),
    ): AgentNetworkStore => {
      const store = createInMemoryNetworkStore();
      return {
        ...store,
        append: async (key, event) => {
          await hold(event);
          return store.append(key, event);
        },
      };
    };

    /** Polls until `done()`. */
    const until = (done: () => boolean) =>
      Effect.gen(function* () {
        while (!done()) yield* Effect.sleep('1 millis');
      });

    test('context scope: a read right after emit() includes the emitted events', async () => {
      const seen: Lines[] = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent, endsOn }) => {
          const model = AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([Step, Done])
            .folds([Steps])
            .logic(async ({ folds, emit }) => {
              emit(Step.make({ n: 1 }));
              seen.push(await folds.steps());
              emit(Step.make({ n: 2 }));
              emit(Step.make({ n: 3 }));
              seen.push(await folds.steps());
              emit(Done.make({}));
            })
            .produce({});
          registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
          endsOn(Done);
        },
        { logger: quietLogger(), store: slowStore() },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* prompt(plane, 'go', meta('run-1'));
        }).pipe(Effect.scoped),
      );

      expect(seen).toEqual([
        ['user: go', 'step 1'],
        ['user: go', 'step 1', 'step 2', 'step 3'],
      ]);
    });

    test('run scope: a read right after emit() counts the emitted events', async () => {
      const counts: number[] = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent, endsOn }) => {
          const model = AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([Step, Done])
            .folds([StepCount])
            .logic(async ({ folds, emit }) => {
              emit(Step.make({ n: 1 }));
              counts.push(await folds.stepCount());
              emit(Step.make({ n: 2 }));
              counts.push(await folds.stepCount());
              emit(Done.make({}));
            })
            .produce({});
          registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
          endsOn(Done);
        },
        { logger: quietLogger(), store: slowStore() },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* prompt(plane, 'go', meta('run-1'));
        }).pipe(Effect.scoped),
      );

      expect(counts).toEqual([1, 2]);
    });

    test("an aggregator's mapToEmit reads its own emits too", async () => {
      const counts: number[] = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAggregator, endsOn }) => {
          registerAggregator(
            EventAggregator.listensTo([UserPrompt])
              .emits([Step, Done])
              .folds([StepCount])
              .mapToEmit(async ({ folds, emit }) => {
                emit(Step.make({ n: 1 }));
                counts.push(await folds.stepCount());
                emit(Done.make({}));
              }),
          )
            .subscribe(mainChannel)
            .publishTo(mainChannel);
          endsOn(Done);
        },
        { logger: quietLogger(), store: slowStore() },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* prompt(plane, 'go', meta('run-1'));
        }).pipe(Effect.scoped),
      );

      expect(counts).toEqual([1]);
    });

    test('a read during emitAndAwait includes the request, and the reply arrives', async () => {
      const counts: number[] = [];
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent, endsOn }) => {
          const asker = AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([Ask, Done])
            .folds([StepCount])
            .logic(async ({ folds, emit, emitAndAwait }) => {
              const [, count] = await Promise.all([
                emitAndAwait(Ask.make({}), Answer.is),
                folds.stepCount(),
              ]);
              counts.push(count);
              emit(Done.make({}));
            })
            .produce({});
          const answerer = AgentFactory.run()
            .listensTo([Ask])
            .emits([Answer], { reply: true })
            .folds([StepCount])
            .logic(async ({ folds, emit }) => {
              counts.push(await folds.stepCount());
              emit(Answer.make({}));
            })
            .produce({});
          registerAgent(asker).subscribe(mainChannel).publishTo(mainChannel);
          registerAgent(answerer).subscribe(mainChannel).publishTo(mainChannel);
          endsOn(Done);
        },
        { logger: quietLogger(), store: slowStore() },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* prompt(plane, 'go', meta('run-1'));
        }).pipe(Effect.scoped),
      );

      // The answerer's read and the asker's both see the request.
      expect(counts.sort()).toEqual([1, 1]);
    });

    test("a read waits for the reader's own emits only, and transient emits never hold it", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = slowStore((event) => (event.name === 'step' ? held : undefined));
      const seen: Record<string, Lines> = {};
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          const writer = AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([Step])
            .folds([Steps])
            .logic(async ({ folds, emit }) => {
              emit(Step.make({ n: 1 }));
              seen.writer = await folds.steps();
            })
            .produce({});
          const reader = AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([Progress])
            .folds([Steps])
            .logic(async ({ folds, emit }) => {
              emit(Progress.make({}));
              seen.reader = await folds.steps();
            })
            .produce({});
          registerAgent(writer).subscribe(mainChannel).publishTo(mainChannel);
          registerAgent(reader).subscribe(mainChannel).publishTo(mainChannel);
        },
        { logger: quietLogger(), store },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* plane.publish(ChannelName('main'), {
            name: 'user-prompt',
            meta: meta('run-1'),
            payload: { text: 'go' },
          });
          // The writer's step is not stored yet: the reader does not wait for it.
          yield* until(() => seen.reader !== undefined);
          expect(seen).toEqual({ reader: ['user: go'] });
          release();
          yield* until(() => seen.writer !== undefined);
        }).pipe(Effect.scoped),
      );

      expect(seen.writer).toEqual(['user: go', 'step 1']);
    });

    describe('an emit that is never stored rejects the read with AgentAbortedError', () => {
      /**
       * Runs `emitThenRead` on a prompt. The logic returns without awaiting the read, so only the
       * plane can settle it (the invocation is never aborted).
       */
      const readAfter = async (
        emitThenRead: (ctx: {
          emit: (event: ReturnType<typeof Step.make>) => void;
          complete: () => void;
          read: () => Promise<Lines>;
        }) => Promise<Lines>,
        setup: AgentNetworkSetupOptions,
      ) => {
        let read: Promise<Lines> | undefined;
        const network = AgentNetwork.setup(
          ({ mainChannel, registerAgent }) => {
            const model = AgentFactory.run()
              .listensTo([UserPrompt])
              .emits([Step])
              .folds([Steps])
              .logic(async ({ folds, emit, complete }) => {
                read = emitThenRead({ emit, complete, read: () => folds.steps() });
                read.catch(() => undefined);
              })
              .produce({});
            registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
          },
          { logger: quietLogger(), ...setup },
        );
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const plane = yield* network.run();
            yield* plane.publish(ChannelName('main'), {
              name: 'user-prompt',
              meta: meta('run-1'),
              payload: { text: 'go' },
            });
            return yield* plane.awaitRunEnd('run-1');
          }).pipe(Effect.scoped),
        );
        return { outcome, read: (read as Promise<Lines>).then((lines) => ({ lines })) };
      };

      test('the run exceeds maxEvents', async () => {
        const { outcome, read } = await readAfter(
          async ({ emit, read }) => {
            emit(Step.make({ n: 1 }));
            emit(Step.make({ n: 2 }));
            return read();
          },
          { maxEvents: 2, store: slowStore() },
        );

        expect(outcome).toMatchObject({
          status: 'failed',
          payload: { error: { kind: 'limit-exceeded', limit: 'events' } },
        });
        await expect(read).rejects.toEqual(new AgentAbortedError('failed'));
      });

      test('the store write fails', async () => {
        const { outcome, read } = await readAfter(
          async ({ emit, read }) => {
            emit(Step.make({ n: 1 }));
            return read();
          },
          {
            store: slowStore((event) =>
              event.name === 'step' ? Promise.reject(new Error('disk full')) : undefined,
            ),
          },
        );

        expect(outcome).toMatchObject({
          status: 'failed',
          payload: { error: { kind: 'store-error' } },
        });
        await expect(read).rejects.toEqual(new AgentAbortedError('failed'));
      });

      test('the run ended before the emit was published', async () => {
        const { outcome, read } = await readAfter(
          async ({ emit, complete, read }) => {
            complete();
            emit(Step.make({ n: 1 }));
            return read();
          },
          { store: slowStore() },
        );

        expect(outcome).toMatchObject({ status: 'completed' });
        await expect(read).rejects.toEqual(new AgentAbortedError('completed'));
      });
    });

    test('an emit after plane.shutdown is dropped: the read after it rejects', async () => {
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let waiting = false;
      let read: Promise<Lines> | undefined;
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          const model = AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([Step])
            .folds([Steps])
            .logic(async ({ folds, emit }) => {
              waiting = true;
              await resumed;
              emit(Step.make({ n: 1 }));
              read = folds.steps();
              await read.catch(() => undefined);
            })
            .produce({});
          registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
        },
        { logger: quietLogger() },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* plane.publish(ChannelName('main'), {
            name: 'user-prompt',
            meta: meta('run-1'),
            payload: { text: 'go' },
          });
          yield* until(() => waiting);
          yield* plane.shutdown;
          resume();
          yield* until(() => read !== undefined);
          yield* Effect.promise(() => (read as Promise<Lines>).catch(() => undefined));
        }).pipe(Effect.scoped),
      );

      await expect(read).rejects.toEqual(new AgentAbortedError('cancelled'));
    });

    test.each([
      ['its scope closes', false],
      ['plane.shutdown runs', true],
    ])('the network stops before the emits are stored (%s): cancelled', async (_, shutdown) => {
      let read: Promise<Lines> | undefined;
      let appending = false;
      const store = slowStore((event) => {
        if (event.name !== 'step') return undefined;
        appending = true;
        return new Promise<void>(() => {});
      });
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          const model = AgentFactory.run()
            .listensTo([UserPrompt])
            .emits([Step])
            .folds([Steps])
            .logic(async ({ folds, emit }) => {
              // The first append never returns; the second emit waits behind it in the outbox.
              emit(Step.make({ n: 1 }));
              emit(Step.make({ n: 2 }));
              read = folds.steps();
              await read.catch(() => undefined);
            })
            .produce({});
          registerAgent(model).subscribe(mainChannel).publishTo(mainChannel);
        },
        { logger: quietLogger(), store },
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* plane.publish(ChannelName('main'), {
            name: 'user-prompt',
            meta: meta('run-1'),
            payload: { text: 'go' },
          });
          yield* until(() => appending && read !== undefined);
          if (shutdown) {
            yield* plane.shutdown;
            // Settled by the shutdown itself, while the scope is still open.
            yield* Effect.promise(() => (read as Promise<Lines>).catch(() => undefined));
          }
        }).pipe(Effect.scoped),
      );

      await expect(read).rejects.toEqual(new AgentAbortedError('cancelled'));
    });
  });

  describe('foldCache option', () => {
    test('maxEntries bounds the states kept per plane', async () => {
      const metrics: NetworkMetric[] = [];
      const network = chatNetwork({
        setup: { foldCache: { maxEntries: 1 }, onMetric: (metric) => metrics.push(metric) },
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* prompt(plane, 'a', meta('run-1', 'ctx-a'));
          yield* prompt(plane, 'b', meta('run-2', 'ctx-b'));
          yield* prompt(plane, 'c', meta('run-3', 'ctx-a'));
          yield* prompt(plane, 'd', meta('run-4', 'ctx-a'));
          expect(inspectEventPlane(plane).foldStates).toBe(1);
        }).pipe(Effect.scoped),
      );

      const reads = metrics.filter((metric) => metric.name === 'm4trix.fold.read.events');
      // ctx-a was evicted by ctx-b, so its second read was cold again.
      expect(reads.map((metric) => [metric.attributes, metric.value])).toEqual([
        [{ fold: 'conversation', start: 'cold' }, 1],
        [{ fold: 'conversation', start: 'cold' }, 1],
        [{ fold: 'conversation', start: 'cold' }, 3],
        [{ fold: 'conversation', start: 'warm' }, 2],
      ]);
      expect(reads[0]).toEqual({
        name: 'm4trix.fold.read.events',
        kind: 'histogram',
        unit: '{event}',
        value: 1,
        attributes: { fold: 'conversation', start: 'cold' },
      });
    });

    test('ttl expires states lazily, on the injected clock', async () => {
      let now = 0;
      const metrics: NetworkMetric[] = [];
      const network = chatNetwork({
        setup: {
          foldCache: { ttl: '1 minute', clock: { unsafeCurrentTimeMillis: () => now } },
          onMetric: (metric) => metrics.push(metric),
        },
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          yield* prompt(plane, 'a', meta('run-1'));
          now += 60_000;
          yield* prompt(plane, 'b', meta('run-2'));
        }).pipe(Effect.scoped),
      );

      expect(
        metrics
          .filter((metric) => metric.name === 'm4trix.fold.read.events')
          .map((metric) => metric.attributes),
      ).toEqual([
        { fold: 'conversation', start: 'cold' },
        { fold: 'conversation', start: 'cold' },
      ]);
    });

    test.each<[FoldCacheOptions, RegExp]>([
      [{ maxEntries: 0 }, /foldCache\.maxEntries must be a positive integer or Infinity, got 0/],
      [{ maxEntries: 2.5 }, /foldCache\.maxEntries/],
      [{ ttl: 0 }, /foldCache\.ttl must be a positive duration or Infinity, got 0/],
      [{ ttl: 'soon' as never }, /foldCache\.ttl/],
    ])('setup rejects %o', (foldCache, message) => {
      expect(() => chatNetwork({ setup: { foldCache } })).toThrow(message);
    });

    test('types', () => {
      expectTypeOf<AgentNetworkSetupOptions['foldCache']>().toEqualTypeOf<
        FoldCacheOptions | undefined
      >();
    });
  });
});
