import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import { createEventHistory, type EventHistory } from '../agent-network/history.js';
import type {
  AgentNetworkStore,
  EventPage,
  StoredEvent,
} from '../agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import { ContextFold, ContextFoldDefinitionError, type FoldSource } from './context-fold.js';
import {
  createFoldCache,
  DEFAULT_FOLD_CACHE_MAX_ENTRIES,
  DEFAULT_FOLD_CACHE_TTL,
  type FoldCacheOptions,
} from './fold-cache.js';
import {
  addFoldSources,
  createFoldReader,
  type DuplicateFoldName,
  type FoldAccessors,
  type FoldCacheEntry,
  type FoldReader,
  type FoldReadInfo,
  foldAccessors,
  type UniqueFoldSources,
} from './fold-reader.js';

/* ─── Fixtures ─── */

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const Reply = AgentNetworkEvent.of('reply', S.Struct({ text: S.String }));
const Compacted = AgentNetworkEvent.of('compacted', S.Struct({ summary: S.String }));
const Unrelated = AgentNetworkEvent.of('unrelated', S.Struct({}));

type Lines = readonly string[];

/** Every handler call, by event id: proves which events a read folded. */
const makeConversation = (applied: string[] = []) =>
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

const makeReplies = (applied: string[] = []) =>
  ContextFold.of('replies', { version: 1 })
    .scope('run')
    .over([Reply])
    .initial(() => 0)
    .on(Reply, (count, { meta }) => {
      applied.push(meta.eventId ?? '?');
      return count + 1;
    });

const scope = { namespace: 'anonymous', contextId: 'ctx-1', runId: 'run-1' };
const key = { namespace: 'anonymous', contextId: 'ctx-1' };

let ids = 0;
const event = (
  def: typeof UserPrompt | typeof Reply | typeof Compacted | typeof Unrelated,
  payload: object,
  runId = 'run-1',
  contextId = 'ctx-1',
): StoredEvent => def.makeBound({ runId, contextId, eventId: `e${++ids}` }, payload);

const prompt = (text: string, runId?: string) => event(UserPrompt, { text }, runId);
const reply = (text: string, runId?: string) => event(Reply, { text }, runId);
const compacted = (summary: string, runId?: string) => event(Compacted, { summary }, runId);

/** An in-memory store with spies on every read, and helpers bound to `key`. */
const setup = (store: AgentNetworkStore = createInMemoryNetworkStore()) => {
  const readContext = vi.spyOn(store, 'readContext');
  const readLatest = vi.spyOn(store as Required<AgentNetworkStore>, 'readLatest');
  const readRun = vi.spyOn(store, 'readRun');
  const history = (runId = 'run-1') => createEventHistory(store, { runId, contextId: 'ctx-1' });
  const append = async (...events: StoredEvent[]) => {
    for (const e of events) await store.append(key, e);
  };
  return { store, readContext, readLatest, readRun, history, append };
};

const cachedReader = (
  history: EventHistory,
  cache = createFoldCache<FoldCacheEntry>(),
  overrides: {
    runId?: string;
    runActive?: () => boolean;
    onRead?: (info: FoldReadInfo) => void;
  } = {},
) =>
  createFoldReader({
    history,
    cache: {
      cache,
      scope: { ...scope, runId: overrides.runId ?? scope.runId },
      runActive: overrides.runActive ?? (() => true),
    },
    ...(overrides.onRead && { onRead: overrides.onRead }),
  });

/** A promise with its resolve function, to hold a read open. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

/* ─── Specs ─── */

describe('createFoldReader without a cache', () => {
  test('folds the whole history on every read, then selects', async () => {
    const { history, append, readContext } = setup();
    const Conversation = makeConversation();
    await append(prompt('hi'), event(Unrelated, {}), reply('hello'));
    const read = createFoldReader({ history: history() });

    expect(await read(Conversation)).toEqual(['user: hi', 'model: hello']);
    await append(prompt('again'));
    expect(await read(Conversation)).toEqual(['user: hi', 'model: hello', 'user: again']);
    // Both reads start from scratch: no cursor is kept.
    expect(readContext.mock.calls.map(([, options]) => options?.after)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test('awaits an async select (views)', async () => {
    const { history, append } = setup();
    const Conversation = makeConversation();
    await append(prompt('hi'), reply('hello'));
    const lastLine: FoldSource<'lastLine', string | undefined> = {
      name: 'lastLine',
      fold: Conversation,
      select: async (state) => (state as Lines).at(-1),
    };

    expect(await createFoldReader({ history: history() })(lastLine)).toBe('model: hello');
  });

  test('an empty history selects the initial state', async () => {
    const { history } = setup();
    const read = createFoldReader({ history: history() });

    expect(await read(makeConversation())).toEqual([]);
    expect(await read(makeReplies())).toBe(0);
  });

  test('reports each read with onRead', async () => {
    const { history, append } = setup();
    await append(prompt('hi'), event(Unrelated, {}));
    const onRead = vi.fn<(info: FoldReadInfo) => void>();

    await createFoldReader({ history: history(), onRead })(makeConversation());

    expect(onRead).toHaveBeenCalledWith({ fold: 'conversation', start: 'cold', events: 1 });
  });
});

describe('createFoldReader with a cache: context scope', () => {
  test('a warm read only reads and folds the events after the cached cursor', async () => {
    const { history, append, readContext } = setup();
    const applied: string[] = [];
    const Conversation = makeConversation(applied);
    const first = prompt('hi');
    await append(first, reply('hello'));
    const read = cachedReader(history());

    expect(await read(Conversation)).toEqual(['user: hi', 'model: hello']);
    const { head } = await history().context({ limit: 1 });
    readContext.mockClear();
    await append(event(Unrelated, {}), prompt('more'));

    expect(await read(Conversation)).toEqual(['user: hi', 'model: hello', 'user: more']);
    expect(readContext).toHaveBeenCalledTimes(1);
    expect(readContext.mock.calls[0]?.[1]).toEqual({
      names: ['user-prompt', 'reply', 'compacted'],
      after: head,
    });
    // Every event was folded exactly once across both reads.
    expect(applied).toHaveLength(3);
    expect(new Set(applied).size).toBe(3);
  });

  test('a warm read with nothing new keeps the state and the cursor', async () => {
    const { history, append, readContext } = setup();
    await append(prompt('hi'));
    const read = cachedReader(history());
    await read(makeConversation());

    expect(await read(makeConversation())).toEqual(['user: hi']);
    expect(await read(makeConversation())).toEqual(['user: hi']);
    const afters = readContext.mock.calls.map(([, options]) => options?.after);
    expect(afters[1]).toBeDefined();
    expect(afters[2]).toBe(afters[1]);
  });

  test('state of an empty context is kept; later events are folded from the start', async () => {
    const { history, append } = setup();
    const read = cachedReader(history());

    expect(await read(makeConversation())).toEqual([]);
    await append(prompt('first'));
    expect(await read(makeConversation())).toEqual(['user: first']);
  });

  test('a cold read starts at the newest checkpoint and folds only the events after it', async () => {
    const { history, append, readContext, readLatest } = setup();
    const applied: string[] = [];
    const Conversation = makeConversation(applied);
    const before = [prompt('old'), reply('old answer'), compacted('first summary')];
    const checkpoint = compacted('talked about the weather');
    const after = [prompt('and now?'), reply('sunny')];
    await append(...before, checkpoint, event(Unrelated, {}), ...after);
    const onRead = vi.fn<(info: FoldReadInfo) => void>();

    const state = await cachedReader(history(), undefined, { onRead })(Conversation);

    expect(state).toEqual(['summary: talked about the weather', 'user: and now?', 'model: sunny']);
    expect(readLatest).toHaveBeenCalledWith(key, ['compacted']);
    const latest = await history().latest(['compacted']);
    expect(readContext.mock.calls[0]?.[1]).toEqual({
      names: ['user-prompt', 'reply', 'compacted'],
      after: latest?.cursor,
    });
    // The events before the checkpoint were never folded.
    expect(applied).toEqual([checkpoint, ...after].map((e) => e.meta.eventId));
    expect(onRead).toHaveBeenCalledWith({ fold: 'conversation', start: 'cold', events: 3 });
  });

  test('a cold read of a fold with a checkpoint but none published folds everything', async () => {
    const { history, append, readContext, readLatest } = setup();
    await append(prompt('hi'));

    expect(await cachedReader(history())(makeConversation())).toEqual(['user: hi']);
    expect(readLatest).toHaveBeenCalledTimes(1);
    expect(readContext.mock.calls[0]?.[1]).toEqual({
      names: ['user-prompt', 'reply', 'compacted'],
    });
  });

  test('a fold without a checkpoint does not look for one', async () => {
    const { history, append, readLatest } = setup();
    await append(reply('a'), reply('b'));
    const Count = ContextFold.of('count', { version: 1 })
      .over([Reply])
      .initial(() => 0)
      .on(Reply, (count) => count + 1);

    expect(await cachedReader(history())(Count)).toBe(2);
    expect(readLatest).not.toHaveBeenCalled();
  });

  test('a checkpoint published later replaces the cached state', async () => {
    const { history, append } = setup();
    await append(prompt('hi'), reply('hello'));
    const read = cachedReader(history());
    await read(makeConversation());

    await append(compacted('greetings'), prompt('next'));

    expect(await read(makeConversation())).toEqual(['summary: greetings', 'user: next']);
  });

  describe('stale cursors', () => {
    test('a deleted context that started over is rebuilt from its new history', async () => {
      const { store, history, append } = setup();
      await append(prompt('secret'), reply('noted'));
      const onRead = vi.fn<(info: FoldReadInfo) => void>();
      const read = cachedReader(history(), undefined, { onRead });
      expect(await read(makeConversation())).toEqual(['user: secret', 'model: noted']);

      await store.deleteContext?.(key);
      await append(prompt('fresh start'), event(Unrelated, {}));

      expect(await read(makeConversation())).toEqual(['user: fresh start']);
      expect(onRead).toHaveBeenLastCalledWith({ fold: 'conversation', start: 'reset', events: 1 });
      // The rebuilt state is warm again.
      await append(reply('welcome'));
      expect(await read(makeConversation())).toEqual(['user: fresh start', 'model: welcome']);
      expect(onRead).toHaveBeenLastCalledWith({ fold: 'conversation', start: 'warm', events: 1 });
    });

    test('a deleted context without new events reads as the initial state', async () => {
      const { store, history, append } = setup();
      await append(prompt('secret'));
      const read = cachedReader(history());
      await read(makeConversation());

      await store.deleteContext?.(key);

      expect(await read(makeConversation())).toEqual([]);
    });

    test('an expired context is rebuilt', async () => {
      let now = 0;
      const { history, append } = setup(
        createInMemoryNetworkStore({
          ttl: '1 minute',
          clock: { unsafeCurrentTimeMillis: () => now },
        }),
      );
      await append(prompt('old'));
      const read = cachedReader(history());
      await read(makeConversation());

      now += 60_000;
      await append(prompt('new'));

      expect(await read(makeConversation())).toEqual(['user: new']);
    });

    test('a checkpoint cursor gone stale during a cold read folds the reset page from the start', async () => {
      const base = setup().history();
      const restarted = [prompt('restarted'), compacted('kept'), reply('after')];
      const history: EventHistory = {
        ...base,
        latest: async () => ({ event: compacted('gone'), cursor: 'stale' }),
        context: async (): Promise<EventPage> => ({ events: restarted, head: 'h', reset: true }),
      };
      const onRead = vi.fn<(info: FoldReadInfo) => void>();

      expect(await cachedReader(history, undefined, { onRead })(makeConversation())).toEqual([
        'summary: kept',
        'model: after',
      ]);
      expect(onRead).toHaveBeenCalledWith({ fold: 'conversation', start: 'reset', events: 3 });
    });
  });

  test('entries are keyed by namespace, context, fold name and version', async () => {
    const store = createInMemoryNetworkStore();
    const cache = createFoldCache<FoldCacheEntry>();
    const other = { namespace: 'principal:bob', contextId: 'ctx-1' };
    await store.append(key, prompt('anonymous'));
    await store.append(other, prompt('bob'));
    await store.append(
      { ...key, contextId: 'ctx-2' },
      event(UserPrompt, { text: 'two' }, 'r', 'ctx-2'),
    );
    const readerFor = (principalId: string | undefined, contextId: string) =>
      createFoldReader({
        history: createEventHistory(store, {
          runId: 'run-1',
          contextId,
          ...(principalId !== undefined && { principalId }),
        }),
        cache: {
          cache,
          scope: {
            namespace: principalId === undefined ? 'anonymous' : `principal:${principalId}`,
            contextId,
            runId: 'run-1',
          },
          runActive: () => true,
        },
      });
    const V2 = ContextFold.of('conversation', { version: 2 })
      .over([UserPrompt])
      .initial(() => 'v2')
      .on(UserPrompt, (state, { payload }) => `${state}+${payload.text}`);

    expect(await readerFor(undefined, 'ctx-1')(makeConversation())).toEqual(['user: anonymous']);
    expect(await readerFor('bob', 'ctx-1')(makeConversation())).toEqual(['user: bob']);
    expect(await readerFor(undefined, 'ctx-2')(makeConversation())).toEqual(['user: two']);
    expect(await readerFor(undefined, 'ctx-1')(V2)).toBe('v2+anonymous');
    expect(cache.size()).toBe(4);
  });

  test('a view reads the cached state of its fold', async () => {
    const { history, append, readContext } = setup();
    await append(prompt('hi'));
    const Conversation = makeConversation();
    const count: FoldSource<'count', number> = {
      name: 'count',
      fold: Conversation,
      select: (state) => (state as Lines).length,
    };
    const read = cachedReader(history());

    expect(await read(Conversation)).toEqual(['user: hi']);
    expect(await read(count)).toBe(1);
    // The second read was warm: it read after the first one's cursor.
    expect(readContext.mock.calls[1]?.[1]?.after).toBeDefined();
  });

  describe('single flight', () => {
    test('interleaved reads of one key never fold an event twice', async () => {
      const { store, append } = setup();
      const applied: string[] = [];
      const Conversation = makeConversation(applied);
      await append(prompt('one'), reply('two'));
      const held = gate();
      const base = createEventHistory(store, { runId: 'run-1', contextId: 'ctx-1' });
      let calls = 0;
      // The first read stalls inside its store read, after taking its page.
      const history: EventHistory = {
        ...base,
        context: async (options) => {
          const page = await base.context(options);
          if (calls++ === 0) await held.opened;
          return page;
        },
      };
      const cache = createFoldCache<FoldCacheEntry>();
      const agentA = cachedReader(history, cache);
      const agentB = cachedReader(history, cache);

      const first = agentA(Conversation);
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Published while the first read is in flight; the second read starts after it.
      await append(prompt('three'));
      const second = agentB(Conversation);
      const third = agentA(Conversation);
      await new Promise((resolve) => setTimeout(resolve, 5));
      held.open();

      expect(await first).toEqual(['user: one', 'model: two']);
      expect(await second).toEqual(['user: one', 'model: two', 'user: three']);
      expect(await third).toEqual(['user: one', 'model: two', 'user: three']);
      expect(applied).toHaveLength(3);
      expect(new Set(applied).size).toBe(3);
    });

    test('a failed read leaves the cached state; the next read continues from it', async () => {
      const { store, append } = setup();
      const applied: string[] = [];
      const Conversation = makeConversation(applied);
      await append(prompt('one'));
      const base = createEventHistory(store, { runId: 'run-1', contextId: 'ctx-1' });
      let failNext = false;
      const history: EventHistory = {
        ...base,
        context: async (options) => {
          if (failNext) {
            failNext = false;
            throw new Error('store down');
          }
          return base.context(options);
        },
      };
      const read = cachedReader(history);
      await read(Conversation);
      await append(reply('two'));

      failNext = true;
      await expect(read(Conversation)).rejects.toThrow('store down');
      expect(await read(Conversation)).toEqual(['user: one', 'model: two']);
      expect(applied).toHaveLength(2);
    });

    test('a throwing handler fails the read and caches nothing', async () => {
      const { history, append } = setup();
      await append(prompt('boom'));
      const Broken = ContextFold.of('broken', { version: 1 })
        .over([UserPrompt])
        .initial(() => 0)
        .on(UserPrompt, () => {
          throw new Error('handler bug');
        });
      const cache = createFoldCache<FoldCacheEntry>();

      await expect(cachedReader(history(), cache)(Broken)).rejects.toThrow('handler bug');
      expect(cache.size()).toBe(0);
    });
  });
});

describe('createFoldReader with a cache: run scope', () => {
  test('folds the run’s events of the fold, then only the new ones', async () => {
    const { history, append, readRun } = setup();
    const applied: string[] = [];
    const Replies = makeReplies(applied);
    await append(prompt('hi'), reply('a'), reply('other run', 'run-2'), reply('b'));
    const onRead = vi.fn<(info: FoldReadInfo) => void>();
    const read = cachedReader(history(), undefined, { onRead });

    expect(await read(Replies)).toBe(2);
    await append(reply('c'), prompt('ignored'));
    expect(await read(Replies)).toBe(3);

    expect(readRun).toHaveBeenCalledWith(key, 'run-1');
    expect(applied).toHaveLength(3);
    expect(onRead.mock.calls.map(([info]) => info)).toEqual([
      { fold: 'replies', start: 'cold', events: 2 },
      { fold: 'replies', start: 'warm', events: 1 },
    ]);
  });

  test('a run with no events yet is cached and continued', async () => {
    const { history, append } = setup();
    const read = cachedReader(history());

    expect(await read(makeReplies())).toBe(0);
    await append(reply('a'));
    expect(await read(makeReplies())).toBe(1);
  });

  test('each run has its own state', async () => {
    const { history, append } = setup();
    const cache = createFoldCache<FoldCacheEntry>();
    await append(reply('a'), reply('b', 'run-2'), reply('c', 'run-2'));

    expect(await cachedReader(history('run-1'), cache)(makeReplies())).toBe(1);
    expect(await cachedReader(history('run-2'), cache, { runId: 'run-2' })(makeReplies())).toBe(2);
    expect(cache.size()).toBe(2);
  });

  test('a run whose stored events no longer continue the cached ones is rebuilt', async () => {
    const { store, history, append } = setup();
    await append(reply('a'), reply('b'));
    const onRead = vi.fn<(info: FoldReadInfo) => void>();
    const read = cachedReader(history(), undefined, { onRead });
    expect(await read(makeReplies())).toBe(2);

    // Deleted and written again: fewer events than were folded.
    await store.deleteContext?.(key);
    await append(reply('c'));
    expect(await read(makeReplies())).toBe(1);
    // As many events as before, but not the same ones.
    await store.deleteContext?.(key);
    await append(reply('d'));
    expect(await read(makeReplies())).toBe(1);

    expect(onRead.mock.calls.map(([info]) => info.start)).toEqual(['cold', 'reset', 'reset']);
  });

  test('state of an ended run is not kept', async () => {
    const { history, append } = setup();
    await append(reply('a'));
    const cache = createFoldCache<FoldCacheEntry>();
    let active = true;
    const read = cachedReader(history(), cache, { runActive: () => active });

    await read(makeReplies());
    expect(cache.size()).toBe(1);
    active = false;
    expect(await read(makeReplies())).toBe(1);
    expect(cache.size()).toBe(0);
  });

  test('context-scoped state is kept whatever the run', async () => {
    const { history, append } = setup();
    await append(prompt('hi'));
    const cache = createFoldCache<FoldCacheEntry>();

    await cachedReader(history(), cache, { runActive: () => false })(makeConversation());

    expect(cache.size()).toBe(1);
  });
});

describe('foldAccessors', () => {
  test('one accessor per source, by its name; every call reads again', async () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();
    const reader = vi.fn<FoldReader>(async (source) => `read ${source.name}`);

    const folds = foldAccessors([Conversation, Replies], reader);

    expect(Object.keys(folds)).toEqual(['conversation', 'replies']);
    expect(await folds.conversation()).toBe('read conversation');
    await folds.conversation();
    expect(await folds.replies()).toBe('read replies');
    expect(reader.mock.calls.map(([source]) => source)).toEqual([
      Conversation,
      Conversation,
      Replies,
    ]);
    expect(Object.isFrozen(folds)).toBe(true);
  });

  test('no sources: no accessors', () => {
    expect(foldAccessors([], vi.fn())).toEqual({});
  });
});

describe('addFoldSources', () => {
  test('appends validated sources', () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();

    expect(addFoldSources([Conversation], [Replies], 'AgentFactory.folds')).toEqual([
      Conversation,
      Replies,
    ]);
  });

  test('rejects two sources with one name, within a call or across calls', () => {
    const Conversation = makeConversation();
    expect(() => addFoldSources([], [Conversation, Conversation], 'AgentFactory.folds')).toThrow(
      'AgentFactory.folds: two fold sources are named "conversation"',
    );
    expect(() => addFoldSources([Conversation], [makeConversation()], 'X.folds')).toThrow(
      /^X\.folds: two fold sources are named "conversation"/,
    );
  });

  test('rejects two different folds with the same name and version (they would share state)', () => {
    const Conversation = makeConversation();
    const lookalike = ContextFold.of('conversation', { version: 1 })
      .over([Reply])
      .initial(() => 0)
      .on(Reply, (n) => n + 1);
    const view: FoldSource<'chat', unknown> = {
      name: 'chat',
      fold: lookalike,
      select: (state) => state,
    };

    expect(() => addFoldSources([Conversation], [view], 'AgentFactory.folds')).toThrow(
      'AgentFactory.folds: "chat" reads a different fold named "conversation" (version 1) than "conversation"',
    );
    // A view of the same fold is fine; so is another version.
    const sameFold: FoldSource<'chat', unknown> = { ...view, fold: Conversation };
    const v2 = ContextFold.of('conversation', { version: 2 })
      .over([Reply])
      .initial(() => 0)
      .on(Reply, (n) => n + 1);
    expect(addFoldSources([Conversation], [sameFold], 'f')).toHaveLength(2);
    expect(
      addFoldSources([Conversation], [{ ...view, name: 'chatV2', fold: v2 }], 'f'),
    ).toHaveLength(2);
  });

  test('validates every source (incomplete folds, non-sources)', () => {
    const incomplete = ContextFold.of('partial', { version: 1 })
      .over([UserPrompt, Reply])
      .initial(() => 0)
      .on(UserPrompt, (n) => n + 1);

    expect(() => addFoldSources([], [incomplete], 'AgentFactory.folds')).toThrow(
      ContextFoldDefinitionError,
    );
    expect(() => addFoldSources([], [{ name: 'x' }], 'AgentFactory.folds')).toThrow(
      ContextFoldDefinitionError,
    );
  });

  test('rejects a non-array', () => {
    expect(() => addFoldSources([], makeConversation() as never, 'AgentFactory.folds')).toThrow(
      'AgentFactory.folds: pass an array of folds and views, e.g. .folds([Conversation])',
    );
  });
});

describe('types', () => {
  test('FoldAccessors: one async accessor per source name, resolving to its result', () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();
    type Chat = FoldSource<'chat', Promise<{ readonly lines: Lines }>>;

    type Folds = FoldAccessors<typeof Conversation | typeof Replies | Chat>;
    expectTypeOf<Folds>().toEqualTypeOf<{
      readonly conversation: () => Promise<Lines>;
      readonly replies: () => Promise<number>;
      readonly chat: () => Promise<{ readonly lines: Lines }>;
    }>();
    expectTypeOf<FoldAccessors<never>>().toEqualTypeOf<Record<never, never>>();
  });

  test('UniqueFoldSources: the sources as they are, or a marker on each duplicate', () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();
    type Ok = readonly [typeof Conversation, typeof Replies];
    expectTypeOf<UniqueFoldSources<Ok, never>>().toEqualTypeOf<Ok>();

    type Twice = readonly [typeof Conversation, typeof Replies, typeof Conversation];
    expectTypeOf<UniqueFoldSources<Twice, never>>().toEqualTypeOf<
      readonly [
        DuplicateFoldName<'conversation'>,
        typeof Replies,
        DuplicateFoldName<'conversation'>,
      ]
    >();
    expectTypeOf<UniqueFoldSources<readonly [typeof Replies], 'replies'>>().toEqualTypeOf<
      readonly [DuplicateFoldName<'replies'>]
    >();
  });

  test('createFoldReader and foldAccessors', () => {
    expectTypeOf(createFoldReader).returns.toEqualTypeOf<FoldReader>();
    expectTypeOf<FoldReader>().toEqualTypeOf<(source: FoldSource) => Promise<unknown>>();
    const folds = foldAccessors([makeReplies()], createFoldReader({ history: setup().history() }));
    expectTypeOf(folds.replies).toEqualTypeOf<() => Promise<number>>();
  });
});

describe('exports', () => {
  test('the main entry points export the public names, not the internals', () => {
    for (const entry of [root, matrix]) {
      expect(entry.DEFAULT_FOLD_CACHE_MAX_ENTRIES).toBe(DEFAULT_FOLD_CACHE_MAX_ENTRIES);
      expect(entry.DEFAULT_FOLD_CACHE_TTL).toBe(DEFAULT_FOLD_CACHE_TTL);
      for (const internal of [
        'createFoldCache',
        'resolveFoldCacheOptions',
        'createFoldReader',
        'foldAccessors',
        'addFoldSources',
      ]) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
    type Folds = FoldAccessors<FoldSource<'a', number>>;
    expectTypeOf<Root.FoldAccessors<FoldSource<'a', number>>>().toEqualTypeOf<Folds>();
    expectTypeOf<Matrix.FoldAccessors<FoldSource<'a', number>>>().toEqualTypeOf<Folds>();
    expectTypeOf<Root.FoldCacheOptions>().toEqualTypeOf<FoldCacheOptions>();
    expectTypeOf<Matrix.FoldCacheOptions>().toEqualTypeOf<FoldCacheOptions>();
    expectTypeOf<Root.FoldReader>().toEqualTypeOf<FoldReader>();
    expectTypeOf<Matrix.FoldReader>().toEqualTypeOf<FoldReader>();
    expectTypeOf<Root.DuplicateFoldName<'a'>>().toEqualTypeOf<DuplicateFoldName<'a'>>();
    expectTypeOf<Matrix.DuplicateFoldName<'a'>>().toEqualTypeOf<DuplicateFoldName<'a'>>();
    type Sources = readonly [FoldSource<'a', number>];
    expectTypeOf<Root.UniqueFoldSources<Sources, never>>().toEqualTypeOf<Sources>();
    expectTypeOf<Matrix.UniqueFoldSources<Sources, never>>().toEqualTypeOf<Sources>();
  });
});
