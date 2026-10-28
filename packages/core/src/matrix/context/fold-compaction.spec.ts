import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import { createEventHistory } from '../agent-network/history.js';
import type { StoredEvent } from '../agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import { ContextFold, type FoldReadStateOf, type FoldStateOf } from './context-fold.js';
import { createFoldCache } from './fold-cache.js';
import {
  type FoldCheckpointPayload,
  FoldCompactionError,
  isFoldCheckpointEvent,
} from './fold-checkpoint.js';
import type {
  FoldAccessor,
  FoldCannotCompact,
  FoldCompact,
  FoldCompactFn,
  SegmentedCompaction,
  SegmentedCompactInput,
  SegmentedCompactOptions,
  SegmentedFoldCompact,
} from './fold-compaction.js';
import {
  createFoldReader,
  type FoldAccessors,
  type FoldCacheEntry,
  type CompactingFoldReader,
  type FoldReadAccessors,
  foldAccessors,
} from './fold-reader.js';
import { SegmentedFold, type SegmentedState } from './segmented-fold.js';
import { ContextStrategy } from './strategies.js';
import { ContextView } from './view.js';

/* ─── Fixtures ─── */

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const Reply = AgentNetworkEvent.of('reply', S.Struct({ text: S.String }));

const Lines = S.Array(S.String);

/** A fold that can compact: it has a state schema and spans the context. */
const makeLog = () =>
  ContextFold.of('log', { state: Lines })
    .initial(() => [])
    .on(UserPrompt, (lines, { payload }) => [...lines, `user: ${payload.text}`])
    .on(Reply, (lines, { payload }) => [...lines, `model: ${payload.text}`]);

/** A fold whose state encodes differently from its type (numbers as strings). */
const makeTotal = () =>
  ContextFold.of('total', { state: S.Struct({ sum: S.NumberFromString }) })
    .initial(() => ({ sum: 0 }))
    .on(UserPrompt, ({ sum }, { payload }) => ({ sum: sum + payload.text.length }));

const key = { namespace: 'anonymous', contextId: 'ctx-1' };
let ids = 0;
const meta = () => ({ runId: 'run-1', contextId: 'ctx-1', eventId: `e${++ids}` });
const prompt = (text: string): StoredEvent => UserPrompt.makeBound(meta(), { text });
const reply = (text: string): StoredEvent => Reply.makeBound(meta(), { text });

/**
 * A store, a history over it, and a reader that publishes checkpoints the way a network does: it
 * appends them, and every read waits until what was published before it is stored.
 */
const setup = () => {
  const store = createInMemoryNetworkStore();
  const history = createEventHistory(store, { runId: 'run-1', contextId: 'ctx-1' });
  const published: Array<{ name: string; payload: FoldCheckpointPayload }> = [];
  let pending: Promise<void> | undefined;
  const append = async (...events: StoredEvent[]) => {
    for (const event of events) await store.append(key, event);
  };
  const reader = (cache = createFoldCache<FoldCacheEntry>()) =>
    createFoldReader({
      history,
      cache: { cache, scope: { ...key, runId: 'run-1' }, runActive: () => true },
      beforeRead: () => pending,
      publishCheckpoint: (checkpoint) => {
        published.push(checkpoint);
        pending = store.append(key, { ...checkpoint, meta: meta() });
      },
    });
  return { store, history, published, append, reader };
};

/** Runs `run` and returns the `FoldCompactionError` it rejects with. */
async function compactionError(run: () => Promise<unknown>): Promise<FoldCompactionError> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(FoldCompactionError);
  return error as FoldCompactionError;
}

/* ─── The reader: compact(fold, next) ─── */

describe('CompactingFoldReader#compact', () => {
  test('publishes the checkpoint: name, version, the cursor of its read as through, the encoded state', async () => {
    const { history, append, published, reader } = setup();
    await append(prompt('one'), reply('first'));
    const read = reader();
    const through = (await history.context({ limit: 1 })).head;
    const next = vi.fn(async (state: unknown) => ({ state: [`summary of ${String(state)}`] }));

    const result = await read.compact?.(makeLog(), next);

    expect(next).toHaveBeenCalledWith(['user: one', 'model: first']);
    expect(published).toEqual([
      {
        name: 'm4trix:fold.checkpoint:log@1',
        payload: {
          fold: 'log',
          version: 1,
          through,
          state: ['summary of user: one,model: first'],
        },
      },
    ]);
    // The state every read returns from now on, warm or cold.
    expect(result).toEqual({ compacted: true, state: ['summary of user: one,model: first'] });
    expect(await read(makeLog())).toEqual(result?.state);
    expect(await reader()(makeLog())).toEqual(result?.state);
  });

  test('the state is stored encoded with the state schema and decoded on read', async () => {
    const { append, published, reader } = setup();
    await append(prompt('abc'));
    const Total = makeTotal();

    const result = await reader().compact?.(Total, async (state) => ({
      state: { sum: (state as { sum: number }).sum * 10 },
    }));

    expect(published[0]?.payload.state).toEqual({ sum: '30' });
    expect(result?.state).toEqual({ sum: 30 });
    expect(await reader()(Total)).toEqual({ sum: 30 });
  });

  test('through is null when the fold has read no event yet', async () => {
    const { published, reader } = setup();

    await reader().compact?.(makeLog(), async () => ({ state: ['seed'] }));

    expect(published[0]?.payload.through).toBeNull();
  });

  test('an event published while next runs is kept: in the result and in a cold read', async () => {
    const { append, reader } = setup();
    await append(prompt('one'));
    const read = reader();

    const result = await read.compact?.(makeLog(), async () => {
      // Another agent publishes while the summary is being written.
      await append(prompt('during'));
      return { state: ['summary: one'] };
    });

    expect(result?.state).toEqual(['summary: one', 'user: during']);
    expect(await reader()(makeLog())).toEqual(['summary: one', 'user: during']);
  });

  test('next may decline (undefined): nothing is published, the state is the one read', async () => {
    const { append, published, reader } = setup();
    await append(prompt('one'));

    const result = await reader().compact?.(makeLog(), async () => undefined);

    expect(result).toEqual({ compacted: false, state: ['user: one'] });
    expect(published).toEqual([]);
  });

  test('a state the schema rejects, or with fields it does not know, rejects and publishes nothing', async () => {
    const { append, published, reader } = setup();
    await append(prompt('one'));
    const read = reader();
    const Total = makeTotal();

    const wrongType = await compactionError(
      () => read.compact?.(makeLog(), async () => ({ state: ['ok', 2] })) as Promise<unknown>,
    );
    const extraField = await compactionError(
      () =>
        read.compact?.(Total, async () => ({ state: { sum: 1, debug: true } })) as Promise<unknown>,
    );

    expect(wrongType).toMatchObject({
      _tag: 'FoldCompactionError',
      foldName: 'log',
      reason: 'invalid-state',
    });
    expect(wrongType.message).toMatch(
      /^folds\.log\.compact\(\): the new state does not match the fold's state schema:/,
    );
    expect(wrongType.cause).toMatchObject({ _tag: 'ParseError' });
    expect(extraField).toMatchObject({ foldName: 'total', reason: 'invalid-state' });
    expect(extraField.message).toContain('debug');
    expect(published).toEqual([]);
    expect(await read(makeLog())).toEqual(['user: one']);
  });

  test('next rejecting rejects compact with its error; nothing is published', async () => {
    const { published, reader } = setup();
    const failure = new Error('the model is down');

    await expect(
      reader().compact?.(makeLog(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(published).toEqual([]);
  });

  test.each([
    [
      'without a state schema',
      ContextFold.of('notes')
        .initial((): readonly string[] => [])
        .on(UserPrompt, (notes, { payload }) => [...notes, payload.text]),
    ],
    [
      'run-scoped',
      ContextFold.of('notes', { scope: 'run', state: Lines })
        .initial(() => [])
        .on(UserPrompt, (notes, { payload }) => [...notes, payload.text]),
    ],
  ])('a fold %s cannot compact: FoldCompactionError, before anything is read', async (_, fold) => {
    const { history, reader } = setup();
    const readContext = vi.spyOn(history, 'context');
    const next = vi.fn();

    const error = await compactionError(() => reader().compact?.(fold, next) as Promise<unknown>);

    expect(error).toMatchObject({ foldName: 'notes', reason: 'unsupported' });
    expect(error.message).toBe(
      'folds.notes.compact(): only a context-scoped fold with a state schema can compact ' +
        '(ContextFold.of(name, { state }) or a SegmentedFold); its checkpoint stores the state ' +
        'encoded with that schema.',
    );
    expect(next).not.toHaveBeenCalled();
    expect(readContext).not.toHaveBeenCalled();
  });

  test('a reader without a publisher (outside a network) cannot compact', () => {
    const { history } = setup();

    expect(createFoldReader({ history }).compact).toBeUndefined();
  });

  test('every read first awaits beforeRead (read-your-writes)', async () => {
    const { history, append } = setup();
    let release!: () => void;
    const stored = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = createFoldReader({ history, beforeRead: () => stored });
    const state = read(makeLog());
    await append(prompt('emitted before the read'));
    release();

    expect(await state).toEqual(['user: emitted before the read']);
  });
});

/* ─── The accessor: folds.<name>.compact(next) ─── */

describe('folds.<name>.compact(next)', () => {
  test('the accessor is still callable; compact(next) resolves to the new state, read-only', async () => {
    const { append, reader } = setup();
    await append(prompt('one'), prompt('two'));
    const Log = makeLog();
    const folds = foldAccessors([Log], reader());

    const state = await folds.log.compact(async (lines) => {
      expectTypeOf(lines).toEqualTypeOf<FoldReadStateOf<typeof Log>>();
      return [`summary: ${lines.length} lines`];
    });

    expect(state).toEqual(['summary: 2 lines']);
    expect(await folds.log()).toEqual(['summary: 2 lines']);
    expectTypeOf(state).toEqualTypeOf<readonly string[]>();
  });

  test('next may return the state synchronously', async () => {
    const { reader } = setup();
    const folds = foldAccessors([makeLog()], reader());

    expect(await folds.log.compact(() => ['seed'])).toEqual(['seed']);
  });

  test('outside a network compact rejects: there is no store to publish the checkpoint to', async () => {
    const { history } = setup();
    const folds = foldAccessors([makeLog()], createFoldReader({ history }));

    const error = await compactionError(() => folds.log.compact(() => []));

    expect(error).toMatchObject({ foldName: 'log', reason: 'unsupported' });
    expect(error.message).toBe(
      'folds.log.compact(): compaction needs a network: the checkpoint is published to its store.',
    );
  });

  test('a fold that cannot compact rejects at runtime too (JavaScript, casts)', async () => {
    const { reader } = setup();
    const Notes = ContextFold.of('notes')
      .initial(() => 0)
      .on(UserPrompt, (count) => count + 1);
    const folds = foldAccessors([Notes], reader());
    const compact = folds.notes.compact as unknown as (next: () => number) => Promise<unknown>;

    expect((await compactionError(() => compact(() => 0))).reason).toBe('unsupported');
  });

  test('read accessors (aggregators) have no compact', () => {
    const { reader } = setup();
    const folds: FoldReadAccessors<ReturnType<typeof makeLog>> = foldAccessors(
      [makeLog()],
      reader(),
      { compact: false },
    );

    expect('compact' in folds.log).toBe(false);
    expect(Object.isFrozen(folds)).toBe(true);
  });
});

/* ─── The policy: folds.<segmented>.compact({ view, budget, keepTokens, summarize }) ─── */

/** A segmented chat: each prompt opens a segment counting its text length in tokens. */
const makeChat = () =>
  SegmentedFold.of('chat', { data: S.Struct({ text: S.String }), summary: S.String }).open(
    UserPrompt,
    ({ meta, payload }) => ({ id: meta.eventId ?? '?', data: { text: payload.text } }),
  );
type ChatState = FoldStateOf<ReturnType<typeof makeChat>>;

const chatView = (fold: ReturnType<typeof makeChat>) =>
  ContextView.of(fold, {
    count: (segment) => segment.data.text.length,
    countSummary: (summary) => summary.length,
  });

/** Prompts of these lengths (each a segment of that many tokens), named a, b, c, ... */
const prompts = (...sizes: number[]) =>
  sizes.map((size, index) => prompt(String.fromCharCode(97 + index).repeat(size)));

describe('folds.<segmented>.compact({ view, budget, keepTokens, keepFrom?, summarize })', () => {
  test('does nothing while the view fits the budget: no summary, no checkpoint', async () => {
    const { append, published, reader } = setup();
    await append(...prompts(10, 10));
    const Chat = makeChat();
    const folds = foldAccessors([Chat], reader());
    const summarize = vi.fn(async () => 'summary');

    const result = await folds.chat.compact({
      view: chatView(Chat),
      budget: 20,
      keepTokens: 10,
      summarize,
    });

    expect(result).toEqual({ compacted: false, state: await folds.chat(), summarized: 0 });
    expect(result.state.segments).toHaveLength(2);
    expect(summarize).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  test('does nothing when compacting cannot help: nothing is older than what it keeps', async () => {
    const { append, published, reader } = setup();
    await append(...prompts(30));
    const Chat = makeChat();
    const folds = foldAccessors([Chat], reader());
    const summarize = vi.fn(async () => 'summary');

    // Over budget, but the only segment is the one a compaction keeps (keepFrom: newest).
    const result = await folds.chat.compact({
      view: chatView(Chat),
      budget: 20,
      keepTokens: 10,
      keepFrom: ContextStrategy.newest(),
      summarize,
    });

    expect(result).toMatchObject({ compacted: false, summarized: 0 });
    expect(summarize).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  test('otherwise summarizes the older segments, keeps the newest that fit keepTokens', async () => {
    const { append, published, reader } = setup();
    const [a, b, c, d] = prompts(10, 10, 10, 10);
    await append(a, b, c, d);
    const Chat = makeChat();
    const read = reader();
    const folds = foldAccessors([Chat], read);
    const summarize = vi.fn(
      async ({ older }: { older: ReadonlyArray<{ id: string }> }) =>
        `summary of ${older.map((segment) => segment.id).join('+')}`,
    );

    const result = await folds.chat.compact({
      view: chatView(Chat),
      budget: 35,
      keepTokens: 20,
      summarize,
    });

    const ids = (events: StoredEvent[]) => events.map((event) => event.meta.eventId);
    expect(summarize).toHaveBeenCalledWith({
      summary: undefined,
      older: ids([a, b]).map((id, index) => ({
        id,
        data: { text: ['a', 'b'][index]?.repeat(10) },
      })),
      kept: ids([c, d]).map((id, index) => ({ id, data: { text: ['c', 'd'][index]?.repeat(10) } })),
    });
    const expected: ChatState = {
      summary: `summary of ${ids([a, b]).join('+')}`,
      segments: [
        { id: c.meta.eventId as string, data: { text: 'c'.repeat(10) } },
        { id: d.meta.eventId as string, data: { text: 'd'.repeat(10) } },
      ],
    };
    expect(result).toEqual({ compacted: true, state: expected, summarized: 2 });
    expect(published[0]?.payload.state).toEqual(expected);
    expect(await reader()(Chat)).toEqual(expected);
  });

  test('a later compaction gets the earlier summary to carry over', async () => {
    const { append, reader } = setup();
    await append(...prompts(10, 10, 10));
    const Chat = makeChat();
    const folds = foldAccessors([Chat], reader());
    const options = {
      view: chatView(Chat),
      budget: 25,
      keepTokens: 10,
      summarize: vi.fn(
        async ({ summary, older }: { summary: string | undefined; older: readonly unknown[] }) =>
          `${summary ?? ''}+${older.length}`,
      ),
    };
    await folds.chat.compact(options);
    await append(prompt('e'.repeat(10)), prompt('f'.repeat(10)));

    const result = await folds.chat.compact(options);

    expect(options.summarize).toHaveBeenLastCalledWith(expect.objectContaining({ summary: '+2' }));
    expect(result.state.summary).toBe('+2+2');
  });

  test('the cut and the checkpoint agree: a prompt published while summarizing is kept', async () => {
    const { append, reader } = setup();
    const [a, b, c] = prompts(10, 10, 10) as [StoredEvent, StoredEvent, StoredEvent];
    await append(a, b, c);
    const Chat = makeChat();
    const folds = foldAccessors([Chat], reader());
    const during = prompt('published while the model summarizes');

    const result = await folds.chat.compact({
      view: chatView(Chat),
      budget: 25,
      keepTokens: 10,
      summarize: async () => {
        await append(during);
        return 'summary';
      },
    });

    // "c" was kept by the cut; "during" came after the read the cut was made from.
    expect(result).toMatchObject({ compacted: true, summarized: 2 });
    expect(result.state.summary).toBe('summary');
    expect(result.state.segments.map((segment) => segment.id)).toEqual([
      c.meta.eventId,
      during.meta.eventId,
    ]);
    expect(await reader()(Chat)).toEqual(result.state);
  });

  test('rejects options that do not fit the fold: TypeError, before anything is read', async () => {
    const { reader } = setup();
    const Chat = makeChat();
    const Other = makeChat();
    const folds = foldAccessors([Chat, makeLog()], reader());
    const valid = { view: chatView(Chat), budget: 10, keepTokens: 5, summarize: async () => '' };
    const compact = folds.chat.compact as (options: unknown) => Promise<unknown>;
    const compactLog = folds.log.compact as unknown as (options: unknown) => Promise<unknown>;

    await expect(compact({ ...valid, view: chatView(Other) })).rejects.toThrow(
      new TypeError(
        'folds.chat.compact(options): view must be a view of this fold ' +
          '(ContextView.of(chat)); summarize must be a function.',
      ),
    );
    await expect(compact({ ...valid, summarize: 'summary' })).rejects.toThrow(TypeError);
    await expect(compact(undefined)).rejects.toThrow(TypeError);
    await expect(compactLog(valid)).rejects.toThrow(
      new TypeError(
        'folds.log.compact(options): the options form is for a SegmentedFold; pass a function ' +
          '(state) => newState.',
      ),
    );
  });

  test('a budget or keepTokens the view rejects rejects compact (RangeError)', async () => {
    const { append, reader } = setup();
    await append(...prompts(10));
    const Chat = makeChat();
    const folds = foldAccessors([Chat], reader());
    const valid = { view: chatView(Chat), budget: 10, keepTokens: 5, summarize: async () => '' };

    await expect(folds.chat.compact({ ...valid, budget: 0 })).rejects.toThrow(RangeError);
    await expect(folds.chat.compact({ ...valid, keepTokens: -1 })).rejects.toThrow(RangeError);
  });

  test('outside a network it rejects like compact(next)', async () => {
    const { history } = setup();
    const Chat = makeChat();
    const folds = foldAccessors([Chat], createFoldReader({ history }));

    const error = await compactionError(() =>
      folds.chat.compact({ view: chatView(Chat), budget: 1, keepTokens: 0, summarize: () => '' }),
    );
    expect(error.reason).toBe('unsupported');
  });

  test('types: the options are typed by the fold; the result has the read state', () => {
    const Chat = makeChat();
    type Compact = FoldAccessors<typeof Chat>['chat']['compact'];

    expectTypeOf<Compact>().toEqualTypeOf<
      SegmentedFoldCompact<{ readonly text: string }, string>
    >();
    expectTypeOf<Compact>().toBeCallableWith({
      view: chatView(Chat),
      budget: 1,
      keepTokens: 1,
      keepFrom: ContextStrategy.newest(),
      summarize: (input: SegmentedCompactInput<{ readonly text: string }, string>) =>
        `${input.summary}${input.older.length}${input.kept.length}`,
    });
    expectTypeOf<Compact>().toBeCallableWith(async (state: ChatState) => state);
    expectTypeOf<SegmentedCompaction<ChatState>>().toEqualTypeOf<{
      readonly compacted: boolean;
      readonly state: ChatState;
      readonly summarized: number;
    }>();
    void ((compact: Compact) =>
      // @ts-expect-error - the summary is a string
      compact({ view: chatView(Chat), budget: 1, keepTokens: 1, summarize: () => 1 }));
    void ((compact: Compact, other: ReturnType<typeof ContextView.of<number, string>>) =>
      // @ts-expect-error - a view of segments of other data
      compact({ view: other, budget: 1, keepTokens: 1, summarize: () => '' }));
  });

  test('types: a segmented fold without a summary schema, or a ContextFold, has compact(next) only', () => {
    const Bare = SegmentedFold.of('bare', { data: S.String }).open(UserPrompt, ({ payload }) => ({
      id: payload.text,
      data: payload.text,
    }));
    const Log = makeLog();

    expectTypeOf<FoldAccessors<typeof Bare>['bare']['compact']>().toEqualTypeOf<
      FoldCompact<typeof Bare>
    >();
    expectTypeOf<FoldCompact<typeof Bare>>().toEqualTypeOf<
      (
        next: (
          state: SegmentedState<string>,
        ) => SegmentedState<string> | Promise<SegmentedState<string>>,
      ) => Promise<SegmentedState<string>>
    >();
    void ((compact: FoldCompact<typeof Log>) =>
      // @ts-expect-error - the options form is for segmented folds with a summary
      compact({ view: chatView(makeChat()), budget: 1, keepTokens: 1, summarize: () => '' }));
  });
});

describe('compaction types', () => {
  test('compact is typed by the fold: the read state in, the state out, the read state back', () => {
    const Log = makeLog();
    type Compact = FoldAccessors<typeof Log>['log']['compact'];

    expectTypeOf<Compact>().toEqualTypeOf<FoldCompact<typeof Log>>();
    expectTypeOf<Compact>().toBeCallableWith(async (lines: readonly string[]) => [...lines]);
    expectTypeOf<Compact>().returns.toEqualTypeOf<Promise<readonly string[]>>();
    void ((compact: Compact) =>
      // @ts-expect-error - the new state must be the fold's state type
      compact(async () => [1]));
  });

  test('a fold that cannot compact has a marker instead: calling it is a type error', () => {
    const Notes = ContextFold.of('notes')
      .initial((): readonly string[] => [])
      .on(UserPrompt, (notes) => notes);
    const RunScoped = ContextFold.of('progress', { scope: 'run', state: S.Number })
      .initial(() => 0)
      .on(Reply, (count) => count + 1);

    expectTypeOf<FoldAccessors<typeof Notes>['notes']['compact']>().toEqualTypeOf<
      FoldCannotCompact<'notes'>
    >();
    expectTypeOf<FoldAccessors<typeof RunScoped>['progress']['compact']>().toEqualTypeOf<
      FoldCannotCompact<'progress'>
    >();
    void ((folds: FoldAccessors<typeof Notes>) =>
      // @ts-expect-error - not callable: the fold has no state schema
      folds.notes.compact(async (notes) => notes));
  });

  test('read accessors are the read functions only', () => {
    const Log = makeLog();

    expectTypeOf<FoldReadAccessors<typeof Log>>().toEqualTypeOf<{
      readonly log: () => Promise<readonly string[]>;
    }>();
    expectTypeOf<CompactingFoldReader['compact']>().not.toBeUndefined();
  });
});

describe('exports', () => {
  test('FoldCompactionError and the compaction types are public; the internals are not', () => {
    for (const entry of [root, matrix]) {
      expect(entry.FoldCompactionError).toBe(FoldCompactionError);
      for (const internal of ['restoreFoldCheckpoint', 'encodeFoldCheckpointState', 'compactor']) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
    expectTypeOf<Root.FoldCannotCompact<'a'>>().toEqualTypeOf<FoldCannotCompact<'a'>>();
    expectTypeOf<Matrix.FoldCompact<ReturnType<typeof makeLog>>>().toEqualTypeOf<
      FoldCompact<ReturnType<typeof makeLog>>
    >();
    expectTypeOf<Root.FoldReadAccessors<never>>().toEqualTypeOf<FoldReadAccessors<never>>();
    // The runtime's compacting reader is internal; the public `FoldReader` only reads.
    // @ts-expect-error not exported
    expectTypeOf<Root.CompactingFoldReader>();
    // @ts-expect-error not exported
    expectTypeOf<Matrix.CompactingFoldReader>();
    expectTypeOf<Root.SegmentedFoldCompact<string, string>>().toEqualTypeOf<
      SegmentedFoldCompact<string, string>
    >();
    expectTypeOf<Matrix.SegmentedCompactOptions<string, string>>().toEqualTypeOf<
      SegmentedCompactOptions<string, string>
    >();
    expectTypeOf<Root.SegmentedCompactInput<string, string>>().toEqualTypeOf<
      SegmentedCompactInput<string, string>
    >();
    expectTypeOf<Matrix.SegmentedCompaction<number>>().toEqualTypeOf<SegmentedCompaction<number>>();
    expectTypeOf<Root.FoldCompactFn<number>>().toEqualTypeOf<FoldCompactFn<number>>();
    expectTypeOf<Matrix.FoldAccessor<ReturnType<typeof makeLog>>>().toEqualTypeOf<
      FoldAccessor<ReturnType<typeof makeLog>>
    >();
    expectTypeOf<Root.FoldCompactionErrorReason>().toEqualTypeOf<'invalid-state' | 'unsupported'>();
    expect(isFoldCheckpointEvent({ name: 'm4trix:fold.checkpoint:log@1' })).toBe(true);
  });
});
