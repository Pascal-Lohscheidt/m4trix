import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from './agent-factory.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import { createEventHistory, type EventHistory } from './agent-network/history.js';
import { createInMemoryNetworkStore } from './agent-network/stores/inmemory-network-store.js';
import {
  ContextFold,
  ContextFoldDefinitionError,
  type FoldSource,
} from './context/context-fold.js';
import type { FoldAccessors, FoldReader } from './context/fold-reader.js';
import { DependencyLayer } from './dependency-layer.js';
import { Tool } from './tool.js';

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const Reply = AgentNetworkEvent.of('reply', S.Struct({ text: S.String }));

type Lines = readonly string[];

const Conversation = ContextFold.of('conversation', { version: 1 })
  .over([UserPrompt, Reply])
  .initial((): Lines => [])
  .on(UserPrompt, (lines, { payload }) => [...lines, `user: ${payload.text}`])
  .on(Reply, (lines, { payload }) => [...lines, `model: ${payload.text}`]);

const Replies = ContextFold.of('replies', { version: 1 })
  .scope('run')
  .over([Reply])
  .initial(() => 0)
  .on(Reply, (count) => count + 1);

const LastLine: FoldSource<'lastLine', string | undefined> = {
  name: 'lastLine',
  fold: Conversation,
  select: async (state) => (state as Lines).at(-1),
};

const meta = { runId: 'run-1', contextId: 'ctx-1' };

/** A history over an in-memory store holding `events` (in run-1 of ctx-1). */
const historyOf = async (
  ...events: Array<ReturnType<typeof UserPrompt.makeBound> | ReturnType<typeof Reply.makeBound>>
): Promise<EventHistory> => {
  const store = createInMemoryNetworkStore();
  for (const event of events)
    await store.append({ namespace: 'anonymous', contextId: 'ctx-1' }, event);
  return createEventHistory(store, meta);
};

describe('AgentFactory.folds', () => {
  test('ctx.folds reads each source over the invocation history', async () => {
    let seen: unknown[] = [];
    const agent = AgentFactory.run()
      .listensTo([UserPrompt])
      .folds([Conversation, LastLine])
      .folds([Replies])
      .logic(async ({ folds }) => {
        seen = [await folds.conversation(), await folds.lastLine(), await folds.replies()];
      })
      .produce({});
    const trigger = UserPrompt.makeBound(meta, { text: 'and now?' });
    const history = await historyOf(
      UserPrompt.makeBound(meta, { text: 'hi' }),
      Reply.makeBound(meta, { text: 'hello' }),
      trigger,
    );

    await agent.invoke({ triggerEvent: trigger, history });

    expect(seen).toEqual([['user: hi', 'model: hello', 'user: and now?'], 'user: and now?', 1]);
    expect(agent.getFolds()).toEqual([Conversation, LastLine, Replies]);
  });

  test('without a history, every source selects the initial state', async () => {
    let seen: unknown[] = [];
    const agent = AgentFactory.run()
      .folds([Conversation, LastLine, Replies])
      .logic(async ({ folds }) => {
        seen = [await folds.conversation(), await folds.lastLine(), await folds.replies()];
      })
      .produce({});

    await agent.invoke();

    expect(seen).toEqual([[], undefined, 0]);
  });

  test('every accessor call reads again', async () => {
    const store = createInMemoryNetworkStore();
    const key = { namespace: 'anonymous', contextId: 'ctx-1' };
    await store.append(key, UserPrompt.makeBound(meta, { text: 'one' }));
    const reads: unknown[] = [];
    const agent = AgentFactory.run()
      .folds([Conversation])
      .logic(async ({ folds }) => {
        reads.push(await folds.conversation());
        await store.append(key, Reply.makeBound(meta, { text: 'two' }));
        reads.push(await folds.conversation());
      })
      .produce({});

    await agent.invoke({ history: createEventHistory(store, meta) });

    expect(reads).toEqual([['user: one'], ['user: one', 'model: two']]);
  });

  test('the factory lists its sources', () => {
    const factory = AgentFactory.run().folds([Conversation, LastLine]);

    expect(factory.getFolds()).toEqual([Conversation, LastLine]);
    expectTypeOf(factory.getFolds()).toEqualTypeOf<
      ReadonlyArray<typeof Conversation | typeof LastLine>
    >();
    expect(AgentFactory.run().getFolds()).toEqual([]);
  });

  test('a network passes its own reader; it takes precedence over the history', async () => {
    const foldReader = vi.fn<FoldReader>(async (source) => `cached ${source.name}`);
    let seen: unknown;
    const agent = AgentFactory.run()
      .folds([Conversation])
      .logic(async ({ folds }) => {
        seen = await folds.conversation();
      })
      .produce({});

    await agent.invoke({ history: await historyOf(), foldReader });

    expect(seen).toBe('cached conversation');
    expect(foldReader).toHaveBeenCalledWith(Conversation);
  });

  test('agents without folds get an empty ctx.folds', async () => {
    let seen: unknown;
    const agent = AgentFactory.run()
      .logic(async ({ folds }) => {
        seen = folds;
      })
      .produce({});

    await agent.invoke();

    expect(seen).toEqual({});
    expect(agent.getFolds()).toEqual([]);
  });

  test('the other builder methods keep the folds', () => {
    const Layer = DependencyLayer.of({ name: 'Cfg', config: S.Struct({ a: S.String }) });
    const tool = Tool.of({ name: 'noop', description: 'Does nothing' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(() => ({}));

    const agent = AgentFactory.run()
      .folds([Conversation])
      .params(S.Struct({}))
      .listensTo([UserPrompt])
      .emits([Reply])
      .dependsOn(Layer)
      .tools(tool)
      .concurrency(2)
      .logic(async () => {})
      .folds([Replies])
      .produce({});

    expect(agent.getFolds()).toEqual([Conversation, Replies]);
  });

  test('a name used twice throws, within one call or across calls', () => {
    expect(() =>
      AgentFactory.run()
        // @ts-expect-error - two sources named "conversation"
        .folds([Conversation, Conversation]),
    ).toThrow('AgentFactory.folds: two fold sources are named "conversation"');

    expect(() =>
      AgentFactory.run()
        .folds([Conversation])
        // @ts-expect-error - "conversation" was added by the previous call
        .folds([Conversation]),
    ).toThrow('AgentFactory.folds: two fold sources are named "conversation"');
  });

  test('an incomplete fold is rejected by the types and at runtime', () => {
    const Incomplete = ContextFold.of('partial', { version: 1 })
      .over([UserPrompt, Reply])
      .initial(() => 0)
      .on(UserPrompt, (n) => n + 1);

    // @ts-expect-error - "reply" has no handler
    expect(() => AgentFactory.run().folds([Incomplete])).toThrow(ContextFoldDefinitionError);
  });

  describe('types', () => {
    test('ctx.folds in logic: an accessor per source name, resolving to its result', () => {
      AgentFactory.run()
        .listensTo([UserPrompt])
        .folds([Conversation, LastLine])
        .folds([Replies])
        .logic(async ({ folds, triggerEvent }) => {
          expectTypeOf(triggerEvent.name).toEqualTypeOf<'user-prompt'>();
          expectTypeOf(folds.conversation).toEqualTypeOf<() => Promise<Lines>>();
          expectTypeOf(folds.lastLine).toEqualTypeOf<() => Promise<string | undefined>>();
          expectTypeOf(folds.replies).toEqualTypeOf<() => Promise<number>>();
          expectTypeOf(folds).toEqualTypeOf<
            FoldAccessors<typeof Conversation | typeof LastLine | typeof Replies>
          >();
          // @ts-expect-error - no source is named "chat"
          folds.chat;
        });
    });

    test('ctx.folds without .folds() has no accessors', () => {
      AgentFactory.run().logic(async ({ folds }) => {
        expectTypeOf(folds).toEqualTypeOf<Record<never, never>>();
        // @ts-expect-error - no folds were declared
        folds.conversation;
      });
    });

    test('logic declared before .folds() still type-checks', () => {
      const factory = AgentFactory.run()
        .logic(async () => {})
        .folds([Conversation]);
      expectTypeOf(factory.produce({}).getFolds()).toEqualTypeOf<ReadonlyArray<FoldSource>>();
    });
  });
});
