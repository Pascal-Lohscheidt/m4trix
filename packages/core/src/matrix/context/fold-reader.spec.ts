import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import { createEventHistory, type EventHistory } from '../agent-network/history.js';
import type {
  AgentNetworkStore,
  StoredEvent,
} from '../agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import {
  type AnyContextFold,
  ContextFold,
  ContextFoldDefinitionError,
  type DeepReadonly,
  type FoldReadStateOf,
  type FoldStateOf,
} from './context-fold.js';
import {
  createFoldCache,
  DEFAULT_FOLD_CACHE_MAX_ENTRIES,
  DEFAULT_FOLD_CACHE_TTL,
  type FoldCacheOptions,
} from './fold-cache.js';
import {
  addFolds,
  createFoldReader,
  type DuplicateFoldName,
  type FoldAccessors,
  type FoldCacheEntry,
  type CompactingFoldReader,
  type FoldReader,
  type FoldReaderOptions,
  type FoldReadInfo,
  foldAccessors,
  type UniqueFolds,
} from './fold-reader.js';
import type { FoldAccessor } from './fold-compaction.js';
import { ContextView } from './view.js';

/* ─── Fixtures ─── */

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const Reply = AgentNetworkEvent.of('reply', S.Struct({ text: S.String }));
const Unrelated = AgentNetworkEvent.of('unrelated', S.Struct({}));

type Lines = readonly string[];

/** Every handler call, by event id: proves which events a read folded. */
const makeConversation = (applied: string[] = []) =>
  ContextFold.of('conversation')
    .initial((): Lines => [])
    .on(UserPrompt, (lines, { payload, meta }) => {
      applied.push(meta.eventId ?? '?');
      return [...lines, `user: ${payload.text}`];
    })
    .on(Reply, (lines, { payload, meta }) => {
      applied.push(meta.eventId ?? '?');
      return [...lines, `model: ${payload.text}`];
    });

/** A fold that can compact (a `state` schema); `applied` records every handler call. */
const makeLog = (applied: string[] = [], version = 1) =>
  ContextFold.of('log', { state: S.Array(S.String), version })
    .initial(() => [])
    .on(UserPrompt, (lines, { payload, meta }) => {
      applied.push(meta.eventId ?? '?');
      return [...lines, `user: ${payload.text}`];
    })
    .on(Reply, (lines, { payload, meta }) => {
      applied.push(meta.eventId ?? '?');
      return [...lines, `model: ${payload.text}`];
    });

const LOG_CHECKPOINT = 'm4trix:fold.checkpoint:log@1';

const makeReplies = (applied: string[] = []) =>
  ContextFold.of('replies', { scope: 'run' })
    .initial(() => 0)
    .on(Reply, (count, { meta }) => {
      applied.push(meta.eventId ?? '?');
      return count + 1;
    });

const scope = { namespace: 'anonymous', contextId: 'ctx-1', runId: 'run-1' };
const key = { namespace: 'anonymous', contextId: 'ctx-1' };

let ids = 0;
const event = (
  def: typeof UserPrompt | typeof Reply | typeof Unrelated,
  payload: object,
  runId = 'run-1',
  contextId = 'ctx-1',
): StoredEvent => def.makeBound({ runId, contextId, eventId: `e${++ids}` }, payload);

const prompt = (text: string, runId?: string) => event(UserPrompt, { text }, runId);
const reply = (text: string, runId?: string) => event(Reply, { text }, runId);
/** A checkpoint of the fold `fold` (default the log), as the runtime stores it. */
const checkpoint = (
  state: readonly string[],
  through: string | undefined,
  version = 1,
  fold = 'log',
): StoredEvent => ({
  name: `m4trix:fold.checkpoint:${fold}@${version}`,
  meta: { runId: 'run-1', contextId: 'ctx-1', eventId: `e${++ids}` },
  payload: { fold, version, through: through ?? null, state },
});
/** A cursor after the context's newest event, as a read now would hand out. */
const cursorNow = async (history: EventHistory) => (await history.context({ limit: 1 })).head;

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
    onSkip?: FoldReaderOptions['onSkip'];
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
    ...(overrides.onSkip && { onSkip: overrides.onSkip }),
  });

/** A read through a fresh cache: what a restarted process (or another plane) reads. */
const coldRead = (
  history: EventHistory,
  fold: AnyContextFold,
  overrides: Parameters<typeof cachedReader>[2] = {},
) => cachedReader(history, createFoldCache<FoldCacheEntry>(), overrides)(fold);

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
  test('folds the whole history on every read', async () => {
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

  test('an empty history reads the initial state', async () => {
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
      names: ['user-prompt', 'reply'],
      after: head,
    });
    // Every event was folded exactly once across both reads.
    expect(applied).toHaveLength(3);
    expect(new Set(applied).size).toBe(3);
  });

  test('a warm read with nothing new keeps the state and the cursor', async () => {
    const { history, append, readContext } = setup();
    await append(prompt('hi'));
    const Conversation = makeConversation();
    const read = cachedReader(history());
    await read(Conversation);

    expect(await read(Conversation)).toEqual(['user: hi']);
    expect(await read(Conversation)).toEqual(['user: hi']);
    const afters = readContext.mock.calls.map(([, options]) => options?.after);
    expect(afters[1]).toBeDefined();
    expect(afters[2]).toBe(afters[1]);
  });

  test('state of an empty context is kept; later events are folded from the start', async () => {
    const { history, append } = setup();
    const Conversation = makeConversation();
    const onRead = vi.fn<(info: FoldReadInfo) => void>();
    const read = cachedReader(history(), undefined, { onRead });

    expect(await read(Conversation)).toEqual([]);
    await append(prompt('first'));
    expect(await read(Conversation)).toEqual(['user: first']);
    expect(onRead.mock.calls.map(([info]) => info)).toEqual([
      { fold: 'conversation', start: 'cold', events: 0 },
      { fold: 'conversation', start: 'warm', events: 1 },
    ]);
  });

  test('a fold that cannot compact does not look for checkpoints, nor read them', async () => {
    const { history, append, readLatest, readContext } = setup();
    // As if a schema-less fold named "conversation" had a checkpoint: it is not its event.
    await append(prompt('a'), checkpoint(['x'], undefined, 1, 'conversation'), reply('b'));

    expect(await cachedReader(history())(makeConversation())).toEqual(['user: a', 'model: b']);
    expect(readLatest).not.toHaveBeenCalled();
    expect(readContext.mock.calls[0]?.[1]).toEqual({ names: ['user-prompt', 'reply'] });
  });

  describe('checkpoints: restore the state, then fold the events after its `through`', () => {
    test('a cold read restores the newest checkpoint and folds everything after its through', async () => {
      const { history, append, readContext, readLatest } = setup();
      const applied: string[] = [];
      const Log = makeLog(applied);
      await append(prompt('one'), reply('first'));
      const through = await cursorNow(history());
      // Published while the compaction ran: after its read, before its checkpoint.
      const during = prompt('two');
      await append(during, event(Unrelated, {}));
      const summary = checkpoint(['summary: one, first'], through);
      const after = reply('second');
      await append(summary, after);
      const onRead = vi.fn<(info: FoldReadInfo) => void>();
      readContext.mockClear();

      const state = await cachedReader(history(), undefined, { onRead })(Log);

      expect(state).toEqual(['summary: one, first', 'user: two', 'model: second']);
      expect(readLatest).toHaveBeenCalledWith(key, [LOG_CHECKPOINT]);
      expect(readContext.mock.calls.map(([, options]) => options)).toEqual([
        { names: ['user-prompt', 'reply', LOG_CHECKPOINT], after: through },
      ]);
      // Only the events after `through` were folded, the one published meanwhile included.
      expect(applied).toEqual([during.meta.eventId, after.meta.eventId]);
      expect(onRead).toHaveBeenCalledWith({ fold: 'log', start: 'cold', events: 3 });
    });

    test('a warm read that meets a checkpoint of its own cursor restores it: no extra read', async () => {
      const { history, append, readContext } = setup();
      const Log = makeLog();
      await append(prompt('one'));
      const read = cachedReader(history());
      expect(await read(Log)).toEqual(['user: one']);
      // The compactor read at the same cursor; a prompt lands before its checkpoint.
      const through = await cursorNow(history());
      await append(prompt('two'), checkpoint(['summary: one'], through));
      readContext.mockClear();

      expect(await read(Log)).toEqual(['summary: one', 'user: two']);
      expect(readContext).toHaveBeenCalledTimes(1);
      expect(await coldRead(history(), Log)).toEqual(['summary: one', 'user: two']);
    });

    test('a checkpoint from an earlier read rebases: the events after its through are folded again', async () => {
      const { history, append, readContext } = setup();
      const applied: string[] = [];
      const Log = makeLog(applied);
      await append(prompt('one'));
      const through = await cursorNow(history());
      const read = cachedReader(history());
      // This reader is ahead of the compactor: it already folded "two".
      const two = prompt('two');
      await append(two);
      expect(await read(Log)).toEqual(['user: one', 'user: two']);
      const head = await cursorNow(history());
      const three = reply('three');
      await append(checkpoint(['summary: one'], through), three);
      readContext.mockClear();
      applied.length = 0;

      expect(await read(Log)).toEqual(['summary: one', 'user: two', 'model: three']);
      expect(readContext.mock.calls.map(([, options]) => options?.after)).toEqual([head, through]);
      expect(applied).toEqual([two.meta.eventId, three.meta.eventId]);
      expect(await coldRead(history(), Log)).toEqual(['summary: one', 'user: two', 'model: three']);
    });

    test('a checkpoint whose through is null folds every event on top of its state', async () => {
      const { history, append } = setup();
      const Log = makeLog();
      await append(prompt('one'), checkpoint(['seed'], undefined), reply('two'));

      expect(await coldRead(history(), Log)).toEqual(['seed', 'user: one', 'model: two']);
    });

    test('several checkpoints in one page: the newest wins, warm and cold alike', async () => {
      const { history, append } = setup();
      const Log = makeLog();
      const read = cachedReader(history());
      await append(prompt('one'));
      expect(await read(Log)).toEqual(['user: one']);
      const first = await cursorNow(history());
      await append(checkpoint(['first summary'], first), prompt('two'));
      const second = await cursorNow(history());
      await append(reply('three'), checkpoint(['second summary'], second), prompt('four'));

      const expected = ['second summary', 'model: three', 'user: four'];
      expect(await read(Log)).toEqual(expected);
      expect(await coldRead(history(), Log)).toEqual(expected);
    });

    test.each([
      ['the later read checkpoints last', 'late', ['late summary', 'model: c']],
      ['the earlier read checkpoints last', 'early', ['early summary', 'user: b', 'model: c']],
    ] as const)('concurrent compactions: %s, and its checkpoint wins, warm and cold alike', async (_, last, expected) => {
      const { history, append } = setup();
      const Log = makeLog();
      const read = cachedReader(history());
      await append(prompt('a'));
      expect(await read(Log)).toEqual(['user: a']);
      // Two compactors: one read after "a", the other after "b".
      const early = await cursorNow(history());
      await append(prompt('b'));
      const late = await cursorNow(history());
      await append(reply('c'));
      const checkpoints = {
        early: checkpoint(['early summary'], early),
        late: checkpoint(['late summary'], late),
      };
      await append(last === 'late' ? checkpoints.early : checkpoints.late, checkpoints[last]);

      expect(await read(Log)).toEqual(expected);
      expect(await coldRead(history(), Log)).toEqual(expected);
    });

    test('checkpoints of another version are never read, cold or warm', async () => {
      const { history, append, readLatest } = setup();
      const V1 = makeLog([], 1);
      const V2 = makeLog([], 2);
      await append(prompt('one'));
      const through = await cursorNow(history());
      const read = cachedReader(history());
      expect(await read(V2)).toEqual(['user: one']);
      await append(checkpoint(['v1 summary'], through, 1), reply('two'));

      expect(await read(V2)).toEqual(['user: one', 'model: two']);
      expect(await coldRead(history(), V2)).toEqual(['user: one', 'model: two']);
      expect(readLatest).toHaveBeenLastCalledWith(key, ['m4trix:fold.checkpoint:log@2']);
      // Version 1 restores its own.
      expect(await coldRead(history(), V1)).toEqual(['v1 summary', 'model: two']);
    });

    test('a checkpoint whose through belongs to a deleted history is ignored, warm and cold', async () => {
      const { store, history, append } = setup();
      const Log = makeLog();
      await append(prompt('secret'));
      const gone = await cursorNow(history());
      await store.deleteContext?.(key);
      await append(prompt('fresh'));
      const read = cachedReader(history());
      expect(await read(Log)).toEqual(['user: fresh']);
      // A compaction of the deleted history lands in the new one.
      await append(checkpoint(['summary: secret'], gone), reply('welcome'));
      const onRead = vi.fn<(info: FoldReadInfo) => void>();

      expect(await read(Log)).toEqual(['user: fresh', 'model: welcome']);
      expect(await coldRead(history(), Log, { onRead })).toEqual(['user: fresh', 'model: welcome']);
      expect(onRead).toHaveBeenCalledWith({ fold: 'log', start: 'reset', events: 2 });
    });

    test('a checkpoint whose through the store does not recognise is ignored, warm and cold', async () => {
      // E.g. a history migrated from another store: the cursor in the checkpoint is foreign.
      const { history, append } = setup();
      const Log = makeLog();
      await append(prompt('one'));
      const through = await cursorNow(history());
      await append(checkpoint(['summary: one'], through), prompt('two'));
      const read = cachedReader(history());
      expect(await read(Log)).toEqual(['summary: one', 'user: two']);

      await append(checkpoint(['foreign summary'], 'pg:1234'), reply('three'));

      // The foreign checkpoint is skipped: the newest usable one (or the start) is restored.
      const expected = ['summary: one', 'user: two', 'model: three'];
      expect(await read(Log)).toEqual(expected);
      expect(await coldRead(history(), Log)).toEqual(expected);
    });

    test('a foreign checkpoint with no usable one before it: folded from the start', async () => {
      const { history, append } = setup();
      const Log = makeLog();
      await append(prompt('one'), checkpoint(['foreign summary'], 'pg:1234'), reply('two'));

      expect(await coldRead(history(), Log)).toEqual(['user: one', 'model: two']);
    });

    test('behind a stale checkpoint, the newest usable one is restored', async () => {
      const { store, history, append } = setup();
      const Log = makeLog();
      await append(prompt('secret'));
      const gone = await cursorNow(history());
      await store.deleteContext?.(key);
      await append(prompt('fresh'));
      const through = await cursorNow(history());
      await append(checkpoint(['summary: fresh'], through), reply('later'));
      await append(checkpoint(['summary: secret'], gone), prompt('last'));

      const expected = ['summary: fresh', 'model: later', 'user: last'];
      expect(await coldRead(history(), Log)).toEqual(expected);
      const read = cachedReader(history());
      expect(await read(Log)).toEqual(expected);
    });

    test('a checkpoint that does not decode is skipped and reported; warm and cold agree', async () => {
      const { history, append } = setup();
      const Log = makeLog();
      await append(prompt('one'));
      const through = await cursorNow(history());
      const usable = checkpoint(['summary: one'], through);
      const invalidState = checkpoint([1] as never, through);
      const invalidPayload: StoredEvent = {
        ...checkpoint([], through),
        payload: { through: 42 },
      };
      await append(usable, prompt('two'), invalidState, invalidPayload);
      const onSkip = vi.fn();
      const warm = cachedReader(history(), undefined, { onSkip });

      const expected = ['summary: one', 'user: two'];
      expect(await coldRead(history(), Log, { onSkip })).toEqual(expected);
      expect(await warm(Log)).toEqual(expected);
      expect(onSkip).toHaveBeenCalledWith({
        fold: 'log',
        reason: 'checkpoint',
        event: invalidState,
        error: expect.objectContaining({ _tag: 'ParseError' }),
      });
      expect(onSkip).toHaveBeenCalledWith({
        fold: 'log',
        reason: 'checkpoint',
        event: invalidPayload,
        error: expect.objectContaining({ _tag: 'ParseError' }),
      });
    });

    test('a checkpoint is decoded (and reported) once per read, also from stores of fresh objects', async () => {
      const { history, append } = setup();
      const Log = makeLog();
      await append(prompt('one'), checkpoint([1] as never, undefined));
      // Every read hands out new objects (e.g. a store that deserializes).
      const fresh: EventHistory = {
        ...history(),
        context: async (options) => structuredClone(await history().context(options)),
        latest: async (names) => structuredClone(await history().latest(names)),
      };
      const onSkip = vi.fn();

      expect(await coldRead(fresh, Log, { onSkip })).toEqual(['user: one']);
      expect(onSkip).toHaveBeenCalledTimes(1);
    });

    test('a checkpoint without an event id (appended by hand) is restored too', async () => {
      const { history, append } = setup();
      const { meta, ...rest } = checkpoint(['seed'], undefined);
      const { eventId: _none, ...withoutId } = meta;
      await append(prompt('one'), { ...rest, meta: withoutId }, reply('two'));

      expect(await coldRead(history(), makeLog())).toEqual(['seed', 'user: one', 'model: two']);
    });

    test('a store that never settles a rebase (it breaks its contract) fails the read loudly', async () => {
      const { history } = setup();
      let reads = 0;
      // Every page holds a newer checkpoint whose `through` is a position the store never resets
      // nor reads as one: a rebase that never ends.
      const broken: EventHistory = {
        ...history(),
        latest: async () => undefined,
        context: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          reads++;
          return { events: [checkpoint([`s${reads}`], `t${reads}`)], head: `h${reads}` };
        },
      };

      await expect(coldRead(broken, makeLog())).rejects.toThrow(
        'fold "log": a read rebased on 100 checkpoints without settling; the store returns ' +
          'pages that do not follow its cursors (see AgentNetworkStore.readContext).',
      );
      expect(reads).toBe(101);
    }, 2_000);

    test('state with a transforming schema is decoded from the checkpoint', async () => {
      const { history, append } = setup();
      const Total = ContextFold.of('total', { state: S.Struct({ sum: S.NumberFromString }) })
        .initial(() => ({ sum: 0 }))
        .on(UserPrompt, ({ sum }, { payload }) => ({ sum: sum + payload.text.length }));
      await append(prompt('abc'));
      const through = await cursorNow(history());
      await append(
        {
          ...checkpoint([], through),
          name: 'm4trix:fold.checkpoint:total@1',
          payload: { fold: 'total', version: 1, through, state: { sum: '10' } },
        },
        prompt('de'),
      );

      expect(await coldRead(history(), Total)).toEqual({ sum: 12 });
    });
  });

  describe('stale cursors', () => {
    test('a deleted context that started over is rebuilt from its new history', async () => {
      const { store, history, append } = setup();
      await append(prompt('secret'), reply('noted'));
      const Conversation = makeConversation();
      const onRead = vi.fn<(info: FoldReadInfo) => void>();
      const read = cachedReader(history(), undefined, { onRead });
      expect(await read(Conversation)).toEqual(['user: secret', 'model: noted']);

      await store.deleteContext?.(key);
      await append(prompt('fresh start'), event(Unrelated, {}));

      expect(await read(Conversation)).toEqual(['user: fresh start']);
      expect(onRead).toHaveBeenLastCalledWith({ fold: 'conversation', start: 'reset', events: 1 });
      // The rebuilt state is warm again.
      await append(reply('welcome'));
      expect(await read(Conversation)).toEqual(['user: fresh start', 'model: welcome']);
      expect(onRead).toHaveBeenLastCalledWith({ fold: 'conversation', start: 'warm', events: 1 });
    });

    test('a deleted context without new events reads as the initial state', async () => {
      const { store, history, append } = setup();
      await append(prompt('secret'));
      const Conversation = makeConversation();
      const onRead = vi.fn<(info: FoldReadInfo) => void>();
      const read = cachedReader(history(), undefined, { onRead });
      await read(Conversation);

      await store.deleteContext?.(key);

      expect(await read(Conversation)).toEqual([]);
      expect(onRead).toHaveBeenLastCalledWith({ fold: 'conversation', start: 'reset', events: 0 });
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
      const Conversation = makeConversation();
      const onRead = vi.fn<(info: FoldReadInfo) => void>();
      const read = cachedReader(history(), undefined, { onRead });
      await read(Conversation);

      now += 60_000;
      await append(prompt('new'));

      expect(await read(Conversation)).toEqual(['user: new']);
      expect(onRead).toHaveBeenLastCalledWith({ fold: 'conversation', start: 'reset', events: 1 });
    });
  });

  test('entries are keyed by namespace and context', async () => {
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
    const Conversation = makeConversation();

    expect(await readerFor(undefined, 'ctx-1')(Conversation)).toEqual(['user: anonymous']);
    expect(await readerFor('bob', 'ctx-1')(Conversation)).toEqual(['user: bob']);
    expect(await readerFor(undefined, 'ctx-2')(Conversation)).toEqual(['user: two']);
    expect(cache.size()).toBe(3);
  });

  test('entries are keyed by the fold object, not its name and version', async () => {
    const { history, append } = setup();
    await append(prompt('hi'), reply('hello'));
    const cache = createFoldCache<FoldCacheEntry>();
    const onRead = vi.fn<(info: FoldReadInfo) => void>();
    const read = cachedReader(history(), cache, { onRead });
    const Conversation = makeConversation();
    // Same name and version, other handlers and state: another fold.
    const Lookalike = ContextFold.of('conversation')
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1)
      .on(Reply, (count) => count + 1);

    expect(await read(Conversation)).toEqual(['user: hi', 'model: hello']);
    expect(await read(Lookalike)).toBe(2);
    await append(prompt('more'));
    expect(await read(Lookalike)).toBe(3);
    expect(await read(Conversation)).toEqual(['user: hi', 'model: hello', 'user: more']);
    // An identical definition is still another object: it does not share the state either.
    expect(await read(makeConversation())).toEqual(['user: hi', 'model: hello', 'user: more']);

    expect(onRead.mock.calls.map(([info]) => info)).toEqual([
      { fold: 'conversation', start: 'cold', events: 2 },
      { fold: 'conversation', start: 'cold', events: 2 },
      { fold: 'conversation', start: 'warm', events: 1 },
      { fold: 'conversation', start: 'warm', events: 1 },
      { fold: 'conversation', start: 'cold', events: 3 },
    ]);
    expect(cache.size()).toBe(3);
  });

  test('cache keys name the fold, for debugging; the id of the fold object keeps them unique', async () => {
    const { history } = setup();
    const cache = createFoldCache<FoldCacheEntry>();
    const update = vi.spyOn(cache, 'update');
    const read = cachedReader(history(), cache);

    await read(makeConversation());
    await read(makeReplies());
    await read(makeConversation());

    const keys = update.mock.calls.map(([{ id, ...rest }]) => ({ id: JSON.parse(id), ...rest }));
    expect(keys).toEqual([
      { id: ['context', 'anonymous', 'ctx-1', 'conversation', expect.any(Number)] },
      { id: ['run', 'anonymous', 'ctx-1', 'run-1', 'replies', expect.any(Number)], runId: 'run-1' },
      { id: ['context', 'anonymous', 'ctx-1', 'conversation', expect.any(Number)] },
    ]);
    // Two folds named "conversation": two ids.
    expect(keys[2]?.id[4]).not.toBe(keys[0]?.id[4]);
  });

  test('a read resolves to the cached state itself: readers share it, read-only', async () => {
    const { history, append, readContext } = setup();
    await append(prompt('hi'));
    const Conversation = makeConversation();
    const read = cachedReader(history());

    const first = await read(Conversation);
    const second = await read(Conversation);

    expect(second).toBe(first);
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
      const Broken = ContextFold.of('broken')
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
    const Replies = makeReplies();
    const onRead = vi.fn<(info: FoldReadInfo) => void>();
    const read = cachedReader(history(), undefined, { onRead });

    expect(await read(Replies)).toBe(0);
    await append(reply('a'));
    expect(await read(Replies)).toBe(1);
    expect(onRead.mock.calls.map(([info]) => info.start)).toEqual(['cold', 'warm']);
  });

  test('each run has its own state', async () => {
    const { history, append } = setup();
    const cache = createFoldCache<FoldCacheEntry>();
    const Replies = makeReplies();
    await append(reply('a'), reply('b', 'run-2'), reply('c', 'run-2'));

    expect(await cachedReader(history('run-1'), cache)(Replies)).toBe(1);
    expect(await cachedReader(history('run-2'), cache, { runId: 'run-2' })(Replies)).toBe(2);
    expect(cache.size()).toBe(2);
  });

  test('two run-scoped folds with one name and version have their own state', async () => {
    const { history, append } = setup();
    await append(reply('a'), reply('b'));
    const cache = createFoldCache<FoldCacheEntry>();
    const read = cachedReader(history(), cache);
    const Replies = makeReplies();
    const Texts = ContextFold.of('replies', { scope: 'run' })
      .initial((): Lines => [])
      .on(Reply, (texts, { payload }) => [...texts, payload.text]);

    expect(await read(Replies)).toBe(2);
    expect(await read(Texts)).toEqual(['a', 'b']);
    await append(reply('c'));
    expect(await read(Texts)).toEqual(['a', 'b', 'c']);
    expect(await read(Replies)).toBe(3);
    expect(cache.size()).toBe(2);
  });

  test('a run whose stored events no longer continue the cached ones is rebuilt', async () => {
    const { store, history, append } = setup();
    await append(reply('a'), reply('b'));
    const Replies = makeReplies();
    const onRead = vi.fn<(info: FoldReadInfo) => void>();
    const read = cachedReader(history(), undefined, { onRead });
    expect(await read(Replies)).toBe(2);

    // Deleted and written again: fewer events than were folded.
    await store.deleteContext?.(key);
    await append(reply('c'));
    expect(await read(Replies)).toBe(1);
    // As many events as before, but not the same ones.
    await store.deleteContext?.(key);
    await append(reply('d'));
    expect(await read(Replies)).toBe(1);

    expect(onRead.mock.calls.map(([info]) => info.start)).toEqual(['cold', 'reset', 'reset']);
  });

  test('state of an ended run is not kept', async () => {
    const { history, append } = setup();
    await append(reply('a'));
    const cache = createFoldCache<FoldCacheEntry>();
    const Replies = makeReplies();
    let active = true;
    const read = cachedReader(history(), cache, { runActive: () => active });

    await read(Replies);
    expect(cache.size()).toBe(1);
    active = false;
    expect(await read(Replies)).toBe(1);
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

describe('stored events are decoded with their event schema before they are folded', () => {
  /** An event whose payload transforms: stored as `{ n: '2', at: '2026-…Z' }`. */
  const Measured = AgentNetworkEvent.of(
    'measured',
    S.Struct({ n: S.NumberFromString, at: S.Date }),
  );
  /** As the runtime stores it: the payload encoded with the event's schema. */
  const measured = (n: number, day: number, runId = 'run-1'): StoredEvent => ({
    name: 'measured',
    meta: { runId, contextId: 'ctx-1', eventId: `e${++ids}` },
    payload: S.encodeSync(Measured.payload)({ n, at: new Date(Date.UTC(2026, 0, day)) }),
  });
  /** Stored before the schema changed: it no longer decodes. */
  const legacy = (runId = 'run-1'): StoredEvent => ({
    name: 'measured',
    meta: { runId, contextId: 'ctx-1', eventId: `e${++ids}` },
    payload: { value: 3 },
  });
  const Totals = ContextFold.of('totals')
    .initial(() => ({ sum: 0, days: [] as readonly number[] }))
    .on(Measured, (state, { payload }) => {
      expectTypeOf(payload.at).toEqualTypeOf<Date>();
      return { sum: state.sum + payload.n, days: [...state.days, payload.at.getUTCDate()] };
    });
  const RunTotals = ContextFold.of('runTotals', { scope: 'run' })
    .initial(() => 0)
    .on(Measured, (sum, { payload }) => sum + payload.n);

  test('handlers get payloads decoded with the event schema, cold and warm alike', async () => {
    const { history, append } = setup();
    await append(measured(2, 1), measured(5, 2));
    const warm = cachedReader(history());

    expect(await warm(Totals)).toEqual({ sum: 7, days: [1, 2] });
    await append(measured(1, 3));
    expect(await warm(Totals)).toEqual({ sum: 8, days: [1, 2, 3] });
    expect(await coldRead(history(), Totals)).toEqual({ sum: 8, days: [1, 2, 3] });
    expect(await coldRead(history(), RunTotals)).toBe(8);
  });

  test('a schema that does not transform: the handler gets the stored payload itself', async () => {
    const { history, append } = setup();
    const payloads: unknown[] = [];
    const Seen = ContextFold.of('seen')
      .initial(() => 0)
      .on(UserPrompt, (count, { payload }) => {
        payloads.push(payload);
        return count + 1;
      });
    await append(prompt('hi'));
    const [stored] = (await history().context()).events;

    await coldRead(history(), Seen);

    expect(payloads[0]).toBe(stored?.payload);
  });

  test('a stored event that does not decode is skipped and reported; warm and cold agree', async () => {
    const { history, append } = setup();
    const bad = legacy();
    await append(measured(2, 1), bad, measured(5, 2));
    const onSkip = vi.fn();
    const warm = cachedReader(history(), undefined, { onSkip });

    expect(await warm(Totals)).toEqual({ sum: 7, days: [1, 2] });
    await append(legacy(), measured(1, 3));
    expect(await warm(Totals)).toEqual({ sum: 8, days: [1, 2, 3] });
    expect(await coldRead(history(), Totals)).toEqual({ sum: 8, days: [1, 2, 3] });
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect(onSkip).toHaveBeenCalledWith({
      fold: 'totals',
      reason: 'decode',
      event: bad,
      error: expect.objectContaining({ _tag: 'ParseError' }),
    });
  });

  test('run scope: undecodable events are skipped and reported the same way', async () => {
    const { history, append } = setup();
    const bad = legacy();
    await append(measured(2, 1), bad, measured(5, 2), measured(9, 3, 'run-2'));
    const onSkip = vi.fn();

    expect(await coldRead(history(), RunTotals, { onSkip })).toBe(7);
    expect(onSkip).toHaveBeenCalledWith({
      fold: 'runTotals',
      reason: 'decode',
      event: bad,
      error: expect.objectContaining({ _tag: 'ParseError' }),
    });
  });

  test('without onSkip, an undecodable event is skipped all the same', async () => {
    const { history, append } = setup();
    await append(measured(2, 1), legacy());

    expect(await createFoldReader({ history: history() })(Totals)).toEqual({ sum: 2, days: [1] });
  });

  test('events of other folds and checkpoints are not decoded with this fold', async () => {
    const { history, append } = setup();
    const onSkip = vi.fn();
    await append(prompt('a'), legacy());

    expect(await coldRead(history(), makeConversation(), { onSkip })).toEqual(['user: a']);
    expect(onSkip).not.toHaveBeenCalled();
  });
});

describe('the state a read resolves to is frozen', () => {
  const Stamped = AgentNetworkEvent.of('stamped', S.Struct({ at: S.Date }));
  const Stamps = ContextFold.of('stamps')
    .initial(() => ({ items: [] as ReadonlyArray<{ readonly at: Date }> }))
    .on(Stamped, (state, { payload }) => ({ items: [...state.items, { at: payload.at }] }));
  type StampsState = FoldStateOf<typeof Stamps>;
  const stamped = (day: number): StoredEvent => ({
    name: 'stamped',
    meta: { runId: 'run-1', contextId: 'ctx-1', eventId: `e${++ids}` },
    payload: { at: new Date(Date.UTC(2026, 0, day)).toISOString() },
  });

  test('plain objects and arrays are frozen deeply; a Date is left as it is', async () => {
    const { history, append } = setup();
    await append(stamped(1));

    const state = (await coldRead(history(), Stamps)) as StampsState;

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.items)).toBe(true);
    expect(Object.isFrozen(state.items[0])).toBe(true);
    expect(Object.isFrozen(state.items[0]?.at)).toBe(false);
  });

  test('a warm read keeps what was frozen before: older parts keep their identity', async () => {
    const { history, append } = setup();
    await append(stamped(1));
    const read = cachedReader(history());
    const first = (await read(Stamps)) as StampsState;
    await append(stamped(2));

    const second = (await read(Stamps)) as StampsState;

    expect(second.items[0]).toBe(first.items[0]);
    expect(Object.isFrozen(second.items[1])).toBe(true);
  });

  test('reads without a cache and run-scoped reads are frozen too', async () => {
    const { history, append } = setup();
    await append(stamped(1));
    const RunStamps = ContextFold.of('runStamps', { scope: 'run' })
      .initial((): ReadonlyArray<string> => [])
      .on(Stamped, (days, { payload }) => [...days, payload.at.toISOString()]);

    expect(Object.isFrozen(await createFoldReader({ history: history() })(Stamps))).toBe(true);
    expect(Object.isFrozen(await coldRead(history(), RunStamps))).toBe(true);
  });

  test('a handler that writes to the state it gets fails the read: the state is read-only', async () => {
    const { history, append } = setup();
    const Impure = ContextFold.of('impure')
      .initial((): string[] => [])
      .on(UserPrompt, (lines, { payload }) => {
        lines.push(payload.text);
        return lines;
      });
    const read = cachedReader(history());
    await append(prompt('a'));
    await read(Impure);
    await append(prompt('b'));

    await expect(read(Impure)).rejects.toThrow(TypeError);
  });

  test('a state restored from a checkpoint is decoded and frozen', async () => {
    const { history, append } = setup();
    const Since = ContextFold.of('since', {
      state: S.Struct({ first: S.Date, count: S.Number }),
    })
      .initial(() => ({ first: new Date(0), count: 0 }))
      .on(Stamped, (state) => ({ ...state, count: state.count + 1 }));
    await append({
      name: 'm4trix:fold.checkpoint:since@1',
      meta: { runId: 'run-1', contextId: 'ctx-1', eventId: `e${++ids}` },
      payload: {
        fold: 'since',
        version: 1,
        through: null,
        state: { first: '2026-01-01T00:00:00.000Z', count: 4 },
      },
    });

    const state = await coldRead(history(), Since);

    expect(state).toEqual({ first: new Date('2026-01-01T00:00:00.000Z'), count: 4 });
    expect(Object.isFrozen(state)).toBe(true);
  });
});

describe('foldAccessors', () => {
  test('one accessor per fold, by its name; every call reads again', async () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();
    const reader = vi.fn<FoldReader>(async (fold) => `read ${fold.name}`);

    const folds = foldAccessors([Conversation, Replies], reader);

    expect(Object.keys(folds)).toEqual(['conversation', 'replies']);
    expect(await folds.conversation()).toBe('read conversation');
    await folds.conversation();
    expect(await folds.replies()).toBe('read replies');
    expect(reader.mock.calls.map(([fold]) => fold)).toEqual([Conversation, Conversation, Replies]);
    expect(Object.isFrozen(folds)).toBe(true);
  });

  test('no folds: no accessors', () => {
    expect(foldAccessors([], vi.fn<FoldReader>())).toEqual({});
  });
});

describe('addFolds', () => {
  test('appends validated folds', () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();

    expect(addFolds([Conversation], [Replies], 'AgentFactory.folds')).toEqual([
      Conversation,
      Replies,
    ]);
  });

  test('rejects two folds with one name, within a call or across calls', () => {
    const Conversation = makeConversation();
    expect(() => addFolds([], [Conversation, Conversation], 'AgentFactory.folds')).toThrow(
      'AgentFactory.folds: two folds are named "conversation"; each needs its own name, its ' +
        'accessor in ctx.folds',
    );
    expect(() => addFolds([Conversation], [makeConversation()], 'X.folds')).toThrow(
      /^X\.folds: two folds are named "conversation"/,
    );
  });

  test('accepts different folds with one name and version (no clash check) in other agents', () => {
    const Lookalike = ContextFold.of('conversation')
      .initial(() => 0)
      .on(Reply, (n) => n + 1);

    expect(addFolds([makeReplies()], [Lookalike], 'AgentFactory.folds')).toHaveLength(2);
  });

  test('validates every fold: folds without events, non-folds and views are rejected', () => {
    const Conversation = makeConversation();
    const empty = ContextFold.of('empty').initial(() => 0);
    const view = ContextView.of(Conversation, { measure: (lines) => lines.length });

    for (const notAFold of [empty, { name: 'x' }, view]) {
      expect(() => addFolds([], [notAFold], 'AgentFactory.folds')).toThrow(
        ContextFoldDefinitionError,
      );
    }
  });

  test('rejects a non-array', () => {
    expect(() => addFolds([], makeConversation() as never, 'AgentFactory.folds')).toThrow(
      'AgentFactory.folds: pass an array of folds, e.g. .folds([Conversation])',
    );
  });
});

describe('types', () => {
  test('FoldAccessors: one accessor per fold name, resolving to its read-only state', () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();
    type Log = { entries: string[] };
    const Mutable = ContextFold.of('log')
      .initial((): Log => ({ entries: [] }))
      .on(UserPrompt, (log) => log);

    const Dated = ContextFold.of('dated', { state: S.Struct({ at: S.DateFromSelf }) })
      .initial(() => ({ at: new Date(0) }))
      .on(UserPrompt, (s) => s);

    type Folds = FoldAccessors<
      typeof Conversation | typeof Replies | typeof Mutable | typeof Dated
    >;
    expectTypeOf<Folds>().toEqualTypeOf<{
      readonly conversation: FoldAccessor<typeof Conversation>;
      readonly replies: FoldAccessor<typeof Replies>;
      readonly log: FoldAccessor<typeof Mutable>;
      readonly dated: FoldAccessor<typeof Dated>;
    }>();
    expectTypeOf<Folds['conversation']>().returns.toEqualTypeOf<Promise<Lines>>();
    expectTypeOf<Folds['replies']>().returns.toEqualTypeOf<Promise<number>>();
    expectTypeOf<Folds['log']>().returns.resolves.toEqualTypeOf<DeepReadonly<Log>>();
    expectTypeOf<Folds['dated']>().returns.resolves.toEqualTypeOf<FoldReadStateOf<typeof Dated>>();
    expectTypeOf<FoldAccessors<never>>().toEqualTypeOf<Record<never, never>>();
  });

  test('UniqueFolds: the folds as they are, or a marker on each duplicate', () => {
    const Conversation = makeConversation();
    const Replies = makeReplies();
    type Ok = readonly [typeof Conversation, typeof Replies];
    expectTypeOf<UniqueFolds<Ok, never>>().toEqualTypeOf<Ok>();

    type Twice = readonly [typeof Conversation, typeof Replies, typeof Conversation];
    expectTypeOf<UniqueFolds<Twice, never>>().toEqualTypeOf<
      readonly [
        DuplicateFoldName<'conversation'>,
        typeof Replies,
        DuplicateFoldName<'conversation'>,
      ]
    >();
    expectTypeOf<UniqueFolds<readonly [typeof Replies], 'replies'>>().toEqualTypeOf<
      readonly [DuplicateFoldName<'replies'>]
    >();
  });

  test('createFoldReader and foldAccessors', () => {
    expectTypeOf(createFoldReader).returns.toEqualTypeOf<CompactingFoldReader>();
    expectTypeOf<FoldReader>().toBeCallableWith(makeReplies());
    expectTypeOf<FoldReader>().returns.toEqualTypeOf<Promise<unknown>>();
    // The public reader is call-only; the runtime's adds compaction.
    expectTypeOf<FoldReader>().toEqualTypeOf<(fold: AnyContextFold) => Promise<unknown>>();
    expectTypeOf<CompactingFoldReader['compact']>().parameter(0).toEqualTypeOf<AnyContextFold>();
    expectTypeOf<FoldReader>().toExtend<CompactingFoldReader>();
    const folds = foldAccessors([makeReplies()], createFoldReader({ history: setup().history() }));
    expectTypeOf(folds.replies).toEqualTypeOf<FoldAccessor<ReturnType<typeof makeReplies>>>();
    const read = foldAccessors([makeReplies()], vi.fn<FoldReader>(), { compact: false });
    expectTypeOf(read.replies).toEqualTypeOf<() => Promise<number>>();
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
        'addFolds',
        'addFoldSources',
      ]) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
    type Replies = ReturnType<typeof makeReplies>;
    type Folds = FoldAccessors<Replies>;
    expectTypeOf<Root.FoldAccessors<Replies>>().toEqualTypeOf<Folds>();
    expectTypeOf<Matrix.FoldAccessors<Replies>>().toEqualTypeOf<Folds>();
    expectTypeOf<Root.FoldCacheOptions>().toEqualTypeOf<FoldCacheOptions>();
    expectTypeOf<Matrix.FoldCacheOptions>().toEqualTypeOf<FoldCacheOptions>();
    expectTypeOf<Root.FoldReader>().toEqualTypeOf<FoldReader>();
    expectTypeOf<Matrix.FoldReader>().toEqualTypeOf<FoldReader>();
    expectTypeOf<Root.DuplicateFoldName<'a'>>().toEqualTypeOf<DuplicateFoldName<'a'>>();
    expectTypeOf<Matrix.DuplicateFoldName<'a'>>().toEqualTypeOf<DuplicateFoldName<'a'>>();
    type List = readonly [Replies];
    expectTypeOf<Root.UniqueFolds<List, never>>().toEqualTypeOf<List>();
    expectTypeOf<Matrix.UniqueFolds<List, never>>().toEqualTypeOf<List>();
  });
});
