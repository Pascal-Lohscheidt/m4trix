import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
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
  type AnySegmentedFold,
  type Segment,
  SegmentedFold,
  type SegmentedState,
} from './segmented-fold.js';
import { ContextStrategy, type ContextStrategyBudget } from './strategies.js';
import {
  approxTokenCount,
  ContextView,
  type ContextViewBuilder,
  type SegmentedContextView,
  type SegmentedViewOptions,
  type StateViewOptions,
  type ViewNeedsMeasure,
  type ViewReadOptions,
  type ViewResult,
  type ViewSplit,
  type ViewSplitOptions,
} from './view.js';

/* ─── Fixtures ─── */

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));

const Entry = S.Struct({ kind: S.Literal('user', 'tool'), text: S.String });
type Entry = typeof Entry.Type;
type State = SegmentedState<Entry, string>;

/** A segmented fold: each prompt opens a segment named after its text. */
const notes = () =>
  SegmentedFold.of('notes', { data: Entry, summary: S.String, tag: 'kind' }).open(
    UserPrompt,
    ({ payload }) => ({
      id: payload.text,
      data: { kind: 'user', text: payload.text },
    }),
  );

const segment = (id: string, size: number, kind: Entry['kind'] = 'user'): Segment<Entry> => ({
  id,
  data: { kind, text: 'x'.repeat(size) },
});
const state = (sizes: Record<string, number>, summary?: string): State => ({
  ...(summary === undefined ? {} : { summary }),
  segments: Object.entries(sizes).map(([id, size]) => segment(id, size)),
});
const ids = (segments: ReadonlyArray<Segment<Entry>>) => segments.map((s) => s.id);
/** Deterministic counters: a segment counts its text length, the summary its length. */
const count = (segment: Segment<Entry>) => segment.data.text.length;
const countSummary = (summary: string) => summary.length;

/** Freezes `value` and everything it holds: a view must never write to the state it reads. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Runs `build` and returns the error of type `type` it throws. */
function thrown<E extends Error>(type: new (...args: never[]) => E, build: () => unknown): E {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    return error as E;
  }
  throw new Error(`expected a ${type.name}`);
}
const definitionError = (build: () => unknown) => thrown(ContextFoldDefinitionError, build);

describe('approxTokenCount', () => {
  test.each([
    ['a string (JSON adds the quotes)', 'abcdef', 2],
    ['an empty string', '', 1],
    ['an object', { a: 1 }, 2],
    ['a segment', { id: 's1', data: 'hello world' }, 8],
    ['undefined', undefined, 0],
  ])('counts %s as ⌈JSON length / 4⌉', (_label, value, tokens) => {
    expect(approxTokenCount(value)).toBe(tokens);
  });
});

describe('ContextView.of a segmented fold', () => {
  test('is a plain function view(state, { budget }): the budget is given per call', () => {
    const view = ContextView.of(notes(), { count });
    const input = state({ a: 10, b: 20 });

    expect(view).toBeTypeOf('function');
    expect(view(input, { budget: 100 })).toMatchObject({ tokens: 30, budget: 100, fits: true });
    expect(view(input, { budget: 20 })).toMatchObject({ tokens: 30, budget: 20, fits: false });
    expect(Object.keys(view(input, { budget: 100 })).sort()).toEqual([
      'budget',
      'dropped',
      'fits',
      'overBudget',
      'state',
      'tokens',
    ]);
    expectTypeOf(view).toEqualTypeOf<SegmentedContextView<Entry, string>>();
    expectTypeOf(view).parameters.toEqualTypeOf<[State, ViewReadOptions]>();
    expectTypeOf(view).returns.toEqualTypeOf<ViewResult<State>>();
    expectTypeOf<ViewReadOptions>().toEqualTypeOf<{ readonly budget: number }>();
  });

  test('knows its fold and is named after it', () => {
    const fold = notes();
    const view = ContextView.of(fold);

    expect(view.fold).toBe(fold);
    expect(view.name).toBe('notesView');
    expectTypeOf(view.fold).toEqualTypeOf<AnySegmentedFold<Entry, string, string>>();
  });

  test('within budget no strategy runs: the state is returned as is, and it fits', () => {
    const strategy = vi.fn<ContextStrategy<State>>((s) => s);
    const view = ContextView.of(notes(), { count, strategies: [strategy] });
    const input = state({ a: 10, b: 20 });

    const result = view(input, { budget: 30 });

    expect(result).toMatchObject({
      state: input,
      tokens: 30,
      budget: 30,
      overBudget: false,
      dropped: [],
      fits: true,
    });
    expect(result.state).toBe(input);
    expect(strategy).not.toHaveBeenCalled();
  });

  test('over budget, strategies run in order until the tokens fit; later ones are skipped', () => {
    const calls: string[] = [];
    const first: ContextStrategy<State> = (s, context) => {
      calls.push(`first ${context.tokens}/${context.budget}`);
      return { ...s, segments: s.segments.slice(1) };
    };
    const second: ContextStrategy<State> = (s) => {
      calls.push('second');
      return s;
    };
    const view = ContextView.of(notes(), { count, strategies: [first, second] });

    const result = view(state({ a: 10, b: 10, c: 10 }), { budget: 25 });

    expect(calls).toEqual(['first 30/25']);
    expect(result).toMatchObject({
      state: state({ b: 10, c: 10 }),
      tokens: 20,
      budget: 25,
      overBudget: false,
      dropped: ['a'],
      fits: false,
    });
  });

  test('each strategy runs at most once; still over budget afterwards → overBudget', () => {
    const tokensSeen: number[] = [];
    const dropFirst: ContextStrategy<State> = (s, { tokens }) => {
      tokensSeen.push(tokens);
      return { ...s, segments: s.segments.slice(1) };
    };
    const view = ContextView.of(notes(), { count, strategies: [dropFirst, dropFirst] });

    const result = view(state({ a: 10, b: 10, c: 10 }), { budget: 5 });

    expect(tokensSeen).toEqual([30, 20]);
    expect(result).toMatchObject({ tokens: 10, overBudget: true, fits: false });
    expect(result.dropped).toEqual(['a', 'b']);
  });

  test('fits: nothing dropped and within budget; elision alone still fits', () => {
    const shorten: ContextStrategy<State> = (s) => ({
      ...s,
      segments: s.segments.map((seg) => ({ ...seg, data: { ...seg.data, text: 'x' } })),
    });
    const view = ContextView.of(notes(), { count, strategies: [shorten] });
    const input = state({ a: 10, b: 10 });

    // Shortened to 2 tokens, every segment still there: the view fits.
    expect(view(input, { budget: 5 })).toMatchObject({ tokens: 2, dropped: [], fits: true });
    // Even shortened, over budget: it does not fit, although nothing was dropped.
    expect(view(input, { budget: 1 })).toMatchObject({
      tokens: 2,
      dropped: [],
      overBudget: true,
      fits: false,
    });
  });

  test('strategies get the view counter; built-ins never split segments', () => {
    const view = ContextView.of(notes(), {
      count,
      strategies: [
        ContextStrategy.elide({
          keepNewest: 1,
          where: (segment) => segment.data.kind === 'tool',
          map: (data) => ({ ...data, text: 'cut' }),
        }),
        ContextStrategy.dropOldest({ keepFrom: ContextStrategy.newest() }),
      ],
    });
    const input: State = {
      segments: [
        segment('u0', 10),
        segment('t1', 40, 'tool'),
        segment('u1', 10),
        segment('t2', 10),
      ],
    };

    const result = view(input, { budget: 20 });

    // elide: t1 40 → 3 (70 → 33 tokens), still over: dropOldest drops u0, t1 (→ 20 tokens).
    expect(ids(result.state.segments)).toEqual(['u1', 't2']);
    expect(result.tokens).toBe(20);
    expect(result.dropped).toEqual(['u0', 't1']);
    expect(input.segments[1]?.data.text).toHaveLength(40);
  });

  test('when nothing may be dropped the view stays over budget', () => {
    const view = ContextView.of(notes(), {
      count,
      strategies: [ContextStrategy.dropOldest({ keepFrom: () => 0 })],
    });
    const input = state({ a: 10, b: 10 });

    expect(view(input, { budget: 10 })).toMatchObject({
      state: input,
      tokens: 20,
      budget: 10,
      overBudget: true,
      dropped: [],
      fits: false,
    });
  });

  test('the summary counts toward the tokens (countSummary, default approxTokenCount)', () => {
    const fold = notes();
    const counted = ContextView.of(fold, { count, countSummary });
    const approximated = ContextView.of(fold, { count });
    const withSummary = state({ a: 10 }, 'summary of 21 letters');

    expect(counted(withSummary, { budget: 100 }).tokens).toBe(10 + 21);
    expect(approximated(withSummary, { budget: 100 }).tokens).toBe(
      10 + approxTokenCount('summary of 21 letters'),
    );
  });

  test('no summary counts nothing; countSummary is not called', () => {
    const spy = vi.fn(countSummary);
    const view = ContextView.of(notes(), { count, countSummary: spy });

    expect(view(state({ a: 10 }), { budget: 100 }).tokens).toBe(10);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a summary over budget alone stays over budget: dropOldest never drops it', () => {
    const view = ContextView.of(notes(), {
      count,
      countSummary,
      strategies: [ContextStrategy.dropOldest()],
    });

    const result = view(state({ a: 10 }, 'a summary that is long'), { budget: 10 });

    expect(result.state).toEqual({ summary: 'a summary that is long', segments: [] });
    expect(result).toMatchObject({ overBudget: true, fits: false, dropped: ['a'] });
  });

  test('options are optional: count defaults to approxTokenCount of each segment', () => {
    const view = ContextView.of(notes());
    const input = state({ a: 10, b: 30 });

    expect(view(input, { budget: 1000 }).tokens).toBe(
      approxTokenCount(input.segments[0]) + approxTokenCount(input.segments[1]),
    );
  });

  test('an empty state counts 0 tokens and fits any budget', () => {
    const view = ContextView.of(notes(), { strategies: [ContextStrategy.dropOldest()] });

    expect(view({ segments: [] }, { budget: 1 })).toMatchObject({
      state: { segments: [] },
      tokens: 0,
      budget: 1,
      overBudget: false,
      dropped: [],
      fits: true,
    });
  });

  test('an Infinity budget means no budget: strategies never run', () => {
    const strategy = vi.fn<ContextStrategy<State>>((s) => s);
    const view = ContextView.of(notes(), { count, strategies: [strategy] });

    const result = view(state({ a: 1_000_000 }), { budget: Infinity });

    expect(result).toMatchObject({ overBudget: false, fits: true, budget: Infinity });
    expect(strategy).not.toHaveBeenCalled();
  });

  test('elided segments are reused across reads, so their counts stay cached too', () => {
    const counter = vi.fn(count);
    const view = ContextView.of(notes(), {
      count: counter,
      strategies: [
        ContextStrategy.elide({ keepNewest: 1, map: (data) => ({ ...data, text: 'cut' }) }),
      ],
    });
    const input = state({ a: 10, b: 10, c: 10 });
    const counted = () => counter.mock.calls.map(([s]) => `${s.id}:${s.data.text.length}`);

    view(input, { budget: 20 });
    expect(counted()).toEqual(['a:10', 'b:10', 'c:10', 'a:3', 'b:3']);
    counter.mockClear();

    // The same old segments elide to the same objects: nothing is counted again.
    view(input, { budget: 20 });
    expect(counted()).toEqual([]);

    // A new segment: it is counted, and c, old now, is elided (and counted) once.
    view({ segments: [...input.segments, segment('d', 10)] }, { budget: 20 });
    expect(counted()).toEqual(['d:10', 'c:3']);
  });

  test('counts each segment once per view, across reads and budgets: counts are cached', () => {
    const counter = vi.fn(count);
    const view = ContextView.of(notes(), {
      count: counter,
      strategies: [ContextStrategy.dropOldest()],
    });
    const input = state({ a: 10, b: 10 });

    view(input, { budget: 15 });
    view(input, { budget: 5 });
    view({ ...input, segments: [...input.segments, segment('c', 5)] }, { budget: 100 });

    expect(counter.mock.calls.map(([s]) => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('dropped lists ids by occurrence: a repeated id kept once is dropped once', () => {
    const view = ContextView.of(notes(), {
      count,
      strategies: [(s) => ({ ...s, segments: s.segments.slice(-1) })],
    });
    const twice = [segment('a', 10), segment('a', 10)];

    expect(view({ segments: [...twice, segment('b', 1)] }, { budget: 10 }).dropped).toEqual([
      'a',
      'a',
    ]);
    expect(view({ segments: twice }, { budget: 10 }).dropped).toEqual(['a']);
  });

  test('reads what the fold folds, and never writes to it (a frozen state works)', () => {
    const fold = notes();
    const view = ContextView.of(fold, {
      count,
      strategies: [
        ContextStrategy.elide({ keepNewest: 1, map: (data) => ({ ...data, text: 'cut' }) }),
        ContextStrategy.dropOldest(),
      ],
    });
    const meta = { runId: 'r', contextId: 'c' };
    const folded = deepFreeze(
      fold.applyAll(fold.initialState(), [
        UserPrompt.makeBound(meta, { text: 'one' }),
        UserPrompt.makeBound(meta, { text: 'two' }),
        UserPrompt.makeBound(meta, { text: 'three' }),
      ]),
    );

    const result = view(folded, { budget: 6 });

    expect(ids(result.state.segments)).toEqual(['three']);
    expect(view.split(folded, { keepTokens: 5 }).kept).toEqual([folded.segments[2]]);
  });

  test('any positive budget works, fractions included (e.g. a share of a window)', () => {
    const view = ContextView.of(notes(), { count });
    const input = state({ a: 10, b: 20 });
    const window = 35;

    expect(view(input, { budget: 29.5 })).toMatchObject({ budget: 29.5, overBudget: true });
    expect(view(input, { budget: 30.5 })).toMatchObject({ budget: 30.5, fits: true });
    expect(view(input, { budget: window * 0.8 })).toMatchObject({ overBudget: true });
    expect(view(input, { budget: Number.MAX_VALUE }).fits).toBe(true);
  });

  test.each([
    0,
    -1,
    -0.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    undefined,
    '10',
  ])('rejects the budget %s when called: a positive number or Infinity', (budget) => {
    const view = ContextView.of(notes());

    const error = thrown(RangeError, () => view(state({}), { budget: budget as number }));

    expect(error.message).toBe(
      'ContextView of fold "notes": the budget must be a positive number of tokens, or ' +
        `Infinity (no budget); got ${budget}.`,
    );
  });

  test('rejects a read without options', () => {
    const view = ContextView.of(notes());

    // @ts-expect-error - the budget is given per read
    expect(() => view(state({}))).toThrow(RangeError);
  });
});

describe('SegmentedContextView#count and #split: budget-free', () => {
  test('count is the view counter, cached per segment: shared with its reads', () => {
    const counter = vi.fn(count);
    const view = ContextView.of(notes(), { count: counter });
    const input = state({ a: 10, b: 20 });

    expect(input.segments.map((s) => view.count(s))).toEqual([10, 20]);
    view(input, { budget: 100 });
    expect(view.count(segment('new', 7))).toBe(7);
    expect(counter).toHaveBeenCalledTimes(3);
    expectTypeOf(view.count).parameters.toEqualTypeOf<[segment: Segment<Entry>]>();
  });

  test('split keeps the newest whole segments that fit keepTokens; the rest is older', () => {
    const view = ContextView.of(notes(), { count });
    const input = state({ a: 10, b: 10, c: 10, d: 10 });

    const { older, kept } = view.split(input, { keepTokens: 25 });

    expect(ids(older)).toEqual(['a', 'b']);
    expect(ids(kept)).toEqual(['c', 'd']);
    expect(kept[0]).toBe(input.segments[2]);
    expectTypeOf(kept).toEqualTypeOf<ReadonlyArray<Segment<Entry>>>();
  });

  test('split never splits a segment and keeps a contiguous suffix', () => {
    const view = ContextView.of(notes(), { count });
    // The newest fits, the one before does not: older stays older even if a smaller one would fit.
    const input = state({ a: 1, b: 50, c: 5 });

    const { older, kept } = view.split(input, { keepTokens: 10 });

    expect(ids(older)).toEqual(['a', 'b']);
    expect(ids(kept)).toEqual(['c']);
  });

  test('split cuts the state as given: it needs no budget and runs no strategy', () => {
    const strategy = vi.fn<ContextStrategy<State>>((s) => ({ ...s, segments: [] }));
    const view = ContextView.of(notes(), { count, strategies: [strategy] });
    const input = state({ a: 10, b: 10, c: 10 });

    const { older, kept } = view.split(input, { keepTokens: 20 });

    expect(ids(older)).toEqual(['a']);
    expect(kept).toEqual(input.segments.slice(1));
    expect(strategy).not.toHaveBeenCalled();
  });

  test('split ignores the summary: it is summarized again with the older segments, not kept', () => {
    const view = ContextView.of(notes(), { count, countSummary });

    const split = view.split(state({ a: 10, b: 10 }, 'a long summary'), { keepTokens: 10 });

    expect(ids(split.older)).toEqual(['a']);
    expect(ids(split.kept)).toEqual(['b']);
  });

  test('keepTokens 0 keeps nothing, Infinity everything; fractions work', () => {
    const view = ContextView.of(notes(), { count });
    const input = state({ a: 10, b: 10 });

    expect(view.split(input, { keepTokens: 0 })).toEqual({ older: input.segments, kept: [] });
    expect(view.split(input, { keepTokens: Infinity })).toEqual({
      older: [],
      kept: input.segments,
    });
    expect(ids(view.split(input, { keepTokens: 19.5 }).kept)).toEqual(['b']);
    expect(ids(view.split(input, { keepTokens: 41 / 2 }).kept)).toEqual(['a', 'b']);
    expect(view.split({ segments: [] }, { keepTokens: 5 })).toEqual({ older: [], kept: [] });
  });

  test('keepFrom: the segments from its index on are always kept, then older ones that fit', () => {
    const view = ContextView.of(notes(), { count });
    const input = state({ a: 10, b: 10, c: 50 });
    const keepFrom = vi.fn((segments: ReadonlyArray<Segment<Entry>>) => segments.length - 1);

    // c alone is over keepTokens, but kept; nothing older fits next to it.
    const newestOnly = view.split(input, { keepTokens: 20, keepFrom });
    expect(ids(newestOnly.older)).toEqual(['a', 'b']);
    expect(ids(newestOnly.kept)).toEqual(['c']);
    expect(keepFrom).toHaveBeenCalledTimes(1);
    expect(keepFrom).toHaveBeenCalledWith(input.segments);
    // c is forced; b fits within 60 next to it, a does not.
    expect(ids(view.split(input, { keepTokens: 60, keepFrom }).kept)).toEqual(['b', 'c']);
    expect(ids(view.split(input, { keepTokens: 0, keepFrom: () => 0 }).kept)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(
      ids(view.split(input, { keepTokens: 0, keepFrom: ContextStrategy.newest() }).kept),
    ).toEqual(['c']);
  });

  test.each([
    -1,
    -0.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    undefined,
  ])('split rejects keepTokens %s: a non-negative number or Infinity', (keepTokens) => {
    const view = ContextView.of(notes());

    const error = thrown(RangeError, () =>
      view.split(state({ a: 1 }), { keepTokens: keepTokens as number }),
    );

    expect(error.message).toBe(
      'ContextView of fold "notes": split() needs keepTokens, a non-negative number of tokens ' +
        `or Infinity; got ${keepTokens}.`,
    );
  });

  test.each([
    -1,
    3,
    0.5,
    Number.NaN,
  ])('split rejects a keepFrom index %s: an integer from 0 to the number of segments', (index) => {
    const view = ContextView.of(notes());

    const error = thrown(RangeError, () =>
      view.split(state({ a: 1, b: 1 }), { keepTokens: 1, keepFrom: () => index }),
    );

    expect(error.message).toBe(
      'ContextView of fold "notes": split(): keepFrom must return an index from 0 to 2 (the ' +
        `number of segments); got ${index}.`,
    );
  });

  test('split and count are typed from the fold state', () => {
    const view = ContextView.of(notes());

    expectTypeOf(view.split).parameters.toEqualTypeOf<[State, ViewSplitOptions<Entry>]>();
    expectTypeOf(view.split).returns.toEqualTypeOf<ViewSplit<Segment<Entry>>>();
    expectTypeOf<ViewSplitOptions<Entry>>().toEqualTypeOf<{
      readonly keepTokens: number;
      readonly keepFrom?: (segments: ReadonlyArray<Segment<Entry>>) => number;
    }>();
    expectTypeOf<ViewSplit<Segment<Entry>>>().toEqualTypeOf<{
      readonly older: ReadonlyArray<Segment<Entry>>;
      readonly kept: ReadonlyArray<Segment<Entry>>;
    }>();
    const ofOneSegment = (s: Segment<Entry>) => s.id.length;
    // @ts-expect-error - keepFrom gets the segments, not one segment
    void (() => view.split(state({}), { keepTokens: 1, keepFrom: ofOneSegment }));
    // @ts-expect-error - keepTokens is required
    expect(() => view.split(state({}))).toThrow(RangeError);
  });
});

describe('ContextView.of a fold without segments', () => {
  type Transcript = { readonly lines: readonly string[] };
  const transcript = () =>
    ContextFold.of('transcript')
      .initial((): Transcript => ({ lines: [] }))
      .on(UserPrompt, (s, { payload }) => ({ lines: [...s.lines, payload.text] }));
  const measure = (s: Transcript) => s.lines.join('').length;

  test('counts the whole state with measure(state); strategies count with it too', () => {
    const keepLast = (
      s: Transcript,
      { count, tokens, budget }: ContextStrategyBudget<Transcript>,
    ): Transcript => {
      expect(count).toBe(measure);
      expect([tokens, budget]).toEqual([9, 5]);
      return { lines: s.lines.slice(-1) };
    };
    const view = ContextView.of(transcript(), { measure, strategies: [keepLast] });

    const result = view({ lines: ['abc', 'def', 'ghi'] }, { budget: 5 });

    expect(result).toEqual({
      state: { lines: ['ghi'] },
      tokens: 3,
      budget: 5,
      overBudget: false,
      dropped: [],
      fits: true,
    });
    expect('split' in view || 'count' in view).toBe(false);
    expectTypeOf(view).toEqualTypeOf<ContextView<Transcript>>();
    expectTypeOf(result).toEqualTypeOf<ViewResult<Transcript>>();
  });

  test('knows its fold and is named after it', () => {
    const fold = transcript();
    const view = ContextView.of(fold, { measure });

    expect(view.fold).toBe(fold);
    expect(view.name).toBe('transcriptView');
    expectTypeOf(view.fold).toEqualTypeOf<AnyContextFold>();
  });

  test('without segments nothing is reported dropped: fits is !overBudget', () => {
    const view = ContextView.of(transcript(), { measure });

    expect(view({ lines: ['abc'] }, { budget: 2 })).toMatchObject({
      tokens: 3,
      overBudget: true,
      fits: false,
    });
    expect(view({ lines: ['abc'] }, { budget: 3 }).fits).toBe(true);
  });

  test('needs measure(state): without segments there is nothing to count by default', () => {
    const fold = transcript();

    // @ts-expect-error - a view of a fold without segments needs measure(state)
    const error = definitionError(() => ContextView.of(fold, {}));
    // @ts-expect-error - and so it needs options
    const noOptions = definitionError(() => ContextView.of(fold));

    expect(error.foldName).toBe('transcript');
    expect(error.message).toBe(
      'ContextView of fold "transcript": the fold has no segments; pass measure(state) to ' +
        'count its tokens, or build the fold with SegmentedFold.',
    );
    expect(noOptions.message).toBe(error.message);
  });

  test('without options, the type error says measure is needed (the last overload)', () => {
    type Overloads = ContextViewBuilder['of'];

    // The one-argument overload a fold without segments falls to: a marker it cannot satisfy.
    expectTypeOf<Parameters<Overloads>>().toEqualTypeOf<
      [fold: AnyContextFold & ViewNeedsMeasure]
    >();
    expectTypeOf<
      keyof ViewNeedsMeasure
    >().toEqualTypeOf<'ContextView.of(fold, { measure }): a fold without segments is counted by measure(state)'>();
  });

  test('helpers take the read-only state: type them with FoldReadStateOf', () => {
    type Log = { entries: string[] };
    const log = ContextFold.of('log')
      .initial((): Log => ({ entries: [] }))
      .on(UserPrompt, (l, { payload }) => ({ entries: [...l.entries, payload.text] }));
    const size = (l: FoldReadStateOf<typeof log>) => l.entries.length;
    const sizeOfMutable = (l: Log) => l.entries.length;

    const view = ContextView.of(log, { measure: size });
    // @ts-expect-error - a helper of the mutable Log could write to the shared, cached state
    void (() => ContextView.of(log, { measure: sizeOfMutable }));

    expect(view({ entries: ['a', 'b'] }, { budget: 10 }).tokens).toBe(2);
    expectTypeOf<FoldReadStateOf<typeof log>>().toEqualTypeOf<DeepReadonly<Log>>();
  });

  test('a fold is segmented by its builder, not by the shape of its state', () => {
    // Its state looks segmented, but it is a ContextFold: it is counted with measure.
    const lookalike = ContextFold.of('lookalike')
      .initial((): SegmentedState<string> => ({ segments: [] }))
      .on(UserPrompt, (s, { payload }) => ({
        segments: [...s.segments, { id: payload.text, data: payload.text }],
      }));
    const measureAll = vi.fn((s: SegmentedState<string>) => s.segments.length);

    // @ts-expect-error - per-segment counting is for SegmentedFold
    const error = definitionError(() => ContextView.of(lookalike, { count: () => 1 }));
    const view = ContextView.of(lookalike, { measure: measureAll });
    const result = view({ segments: [{ id: 'a', data: 'a' }] }, { budget: 10 });

    expect(error.message).toBe(
      'ContextView of fold "lookalike": count and countSummary count segments of a ' +
        'SegmentedFold; a fold without segments takes measure(state).',
    );
    expect(result.tokens).toBe(1);
    expect(measureAll).toHaveBeenCalledWith({ segments: [{ id: 'a', data: 'a' }] });
    expect('split' in result).toBe(false);
    expectTypeOf(view).toEqualTypeOf<ContextView<SegmentedState<string>>>();
  });

  test('rejects segment strategies at type level', () => {
    const fold = transcript();

    void (() =>
      // @ts-expect-error - built-in segment strategies need a segmented fold (no overload matches)
      ContextView.of(fold, { measure, strategies: [ContextStrategy.dropOldest()] }));
    expect(fold.name).toBe('transcript');
  });
});

describe('ContextView.of validation', () => {
  test('takes a fold: not a builder, a view or anything else', () => {
    const view = ContextView.of(notes());

    for (const notAFold of [
      ContextFold.of('pending'),
      view,
      { name: 'notes' },
      undefined,
    ] as const) {
      // @ts-expect-error - ContextView.of takes a fold
      expect(() => ContextView.of(notAFold)).toThrow(ContextFoldDefinitionError);
    }
  });

  test('rejects a fold without events', () => {
    const empty = SegmentedFold.of('notes', { data: Entry });

    expect(definitionError(() => ContextView.of(empty)).message).toBe(
      'SegmentedFold "notes": it folds no events; add a handler (.open(), .attach() or .on()).',
    );
  });

  test('rejects strategies that are not functions', () => {
    const fold = notes();
    const message =
      'ContextView of fold "notes": strategies must be an array of functions ' +
      '(state, { budget, tokens, count }) => state.';

    expect(
      definitionError(() =>
        // @ts-expect-error - a strategy is a function (no overload matches)
        ContextView.of(fold, { strategies: [ContextStrategy.dropOldest(), 'elide'] }),
      ).message,
    ).toBe(message);
    expect(
      // @ts-expect-error - strategies are an array
      definitionError(() => ContextView.of(fold, { strategies: ContextStrategy.dropOldest() }))
        .message,
    ).toBe(message);
  });

  test('rejects counters that are not functions', () => {
    const fold = notes();
    const message =
      'ContextView of fold "notes": count, countSummary and measure must be functions.';

    // @ts-expect-error - count is a function
    expect(definitionError(() => ContextView.of(fold, { count: 10 })).message).toBe(message);
    expect(
      // @ts-expect-error - countSummary is a function
      definitionError(() => ContextView.of(fold, { countSummary: 'len' })).message,
    ).toBe(message);
  });

  test('rejects measure for a segmented fold: it counts per segment', () => {
    const error = definitionError(() =>
      // @ts-expect-error - segmented folds count per segment (count), not the whole state
      ContextView.of(notes(), { measure: (s: State) => s.segments.length }),
    );

    expect(error.message).toBe(
      'ContextView of fold "notes": a SegmentedFold is counted per segment; pass ' +
        'count(segment) (and countSummary), not measure.',
    );
  });

  test('views are independent of each other and of the fold', () => {
    const fold = notes();
    const strict = ContextView.of(fold, { count, strategies: [ContextStrategy.dropOldest()] });
    const loose = ContextView.of(fold, { count });
    const input = state({ a: 10, b: 10 });

    expect(strict(input, { budget: 10 }).dropped).toEqual(['a']);
    expect(loose(input, { budget: 10 }).dropped).toEqual([]);
    expect(fold.applyAll(input, [])).toBe(input);
  });
});

describe('view types', () => {
  test('counters and strategies are typed from the fold state', () => {
    const view = ContextView.of(notes(), {
      count: (segment) => {
        expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
        return segment.data.text.length;
      },
      countSummary: (summary) => {
        expectTypeOf(summary).toEqualTypeOf<string>();
        return summary.length;
      },
      strategies: [
        (s, { count: counter }) => {
          expectTypeOf(s).toEqualTypeOf<State>();
          expectTypeOf(counter).toEqualTypeOf<(segment: Segment<Entry>) => number>();
          return s;
        },
      ],
    });

    const result = view(state({ a: 1 }), { budget: 100 });
    expectTypeOf(result.state.segments).toEqualTypeOf<ReadonlyArray<Segment<Entry>>>();
    expectTypeOf(result.dropped).toEqualTypeOf<ReadonlyArray<string>>();
    expectTypeOf(result.fits).toEqualTypeOf<boolean>();
    expectTypeOf(result.overBudget).toEqualTypeOf<boolean>();
  });

  test('a view reads the read-only state of the fold, as ctx.folds returns it', () => {
    type Log = { entries: string[]; meta: { count: number } };
    const fold = ContextFold.of('log')
      .initial((): Log => ({ entries: [], meta: { count: 0 } }))
      .on(UserPrompt, (log, { payload }) => ({
        entries: [...log.entries, payload.text],
        meta: { count: log.meta.count + 1 },
      }));
    const view = ContextView.of(fold, {
      measure: (log) => {
        expectTypeOf(log).toEqualTypeOf<DeepReadonly<Log>>();
        // @ts-expect-error - the state is read-only
        void (() => log.entries.push('x'));
        // @ts-expect-error - all the way down
        void (() => (log.meta.count = 1));
        return log.entries.length;
      },
    });
    const read: DeepReadonly<Log> = { entries: ['a'], meta: { count: 1 } };

    expect(view(read, { budget: 10 }).tokens).toBe(1);
    expectTypeOf(view).parameters.toEqualTypeOf<[DeepReadonly<Log>, ViewReadOptions]>();
    expectTypeOf(view(read, { budget: 10 }).state).toEqualTypeOf<DeepReadonly<Log>>();
  });

  test('a fold with a state schema is viewed with its schema type, as it is read', () => {
    const Event = S.Struct({ at: S.DateFromSelf, note: S.Option(S.String) });
    const timeline = ContextFold.of('timeline', { state: S.Struct({ events: S.Array(Event) }) })
      .initial(() => ({ events: [] }))
      .on(UserPrompt, (s) => s);

    const view = ContextView.of(timeline, {
      measure: (s) => {
        expectTypeOf(s).toEqualTypeOf<FoldStateOf<typeof timeline>>();
        expectTypeOf<(typeof s.events)[number]['at']>().toEqualTypeOf<Date>();
        return s.events.length;
      },
    });

    expect(view({ events: [] }, { budget: 1 }).tokens).toBe(0);
  });

  test('ContextView.of picks by fold kind: SegmentedFold or any other fold', () => {
    const segmented = notes();
    const bare = SegmentedFold.of('bare', { data: S.String }).open(UserPrompt, ({ payload }) => ({
      id: payload.text,
      data: payload.text,
    }));
    const plain = ContextFold.of('n')
      .initial(() => 0)
      .on(UserPrompt, (n) => n + 1);

    expectTypeOf(ContextView.of(segmented)).toEqualTypeOf<SegmentedContextView<Entry, string>>();
    expectTypeOf(ContextView.of(bare)).toEqualTypeOf<SegmentedContextView<string>>();
    expectTypeOf(ContextView.of(plain, { measure: (n) => n })).toEqualTypeOf<ContextView<number>>();
    expectTypeOf<Parameters<typeof ContextView.of<Entry, string>>[1]>().toEqualTypeOf<
      SegmentedViewOptions<Entry, string> | undefined
    >();
    expectTypeOf<SegmentedViewOptions<Entry, string>>().toEqualTypeOf<{
      readonly count?: (segment: Segment<Entry>) => number;
      readonly countSummary?: (summary: string) => number;
      readonly strategies?: ReadonlyArray<ContextStrategy<State>>;
    }>();
    expectTypeOf<StateViewOptions<number>>().toEqualTypeOf<{
      readonly measure: (state: number) => number;
      readonly strategies?: ReadonlyArray<
        (state: number, context: ContextStrategyBudget<number>) => number
      >;
    }>();
    expectTypeOf<FoldStateOf<typeof segmented>>().toEqualTypeOf<State>();
  });
});

describe('exports', () => {
  test('ContextView, its types and approxTokenCount are exported by name; internals are not', () => {
    for (const entry of [root, matrix]) {
      expect(entry.ContextView).toBe(ContextView);
      expect(entry.approxTokenCount).toBe(approxTokenCount);
      for (const internal of [
        'approxTokens',
        'createView',
        'isSegmentedState',
        'isSegmentedFold',
      ]) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
    expect(Object.keys(ContextView)).toEqual(['of']);
    expect(Object.isFrozen(ContextView)).toBe(true);
    expectTypeOf<Root.ContextView<State>>().toEqualTypeOf<ContextView<State>>();
    expectTypeOf<Matrix.SegmentedContextView<Entry, string>>().toEqualTypeOf<
      SegmentedContextView<Entry, string>
    >();
    expectTypeOf<Root.ViewResult<State>>().toEqualTypeOf<ViewResult<State>>();
    expectTypeOf<Matrix.ViewNeedsMeasure>().toEqualTypeOf<ViewNeedsMeasure>();
    expectTypeOf<Root.ContextViewBuilder>().toEqualTypeOf<ContextViewBuilder>();
    expectTypeOf(ContextView).toEqualTypeOf<Matrix.ContextViewBuilder>();
    expectTypeOf<Root.ViewReadOptions>().toEqualTypeOf<ViewReadOptions>();
    expectTypeOf<Matrix.ViewSplit<Segment<Entry>>>().toEqualTypeOf<ViewSplit<Segment<Entry>>>();
    expectTypeOf<Root.ViewSplitOptions<Entry>>().toEqualTypeOf<ViewSplitOptions<Entry>>();
    expectTypeOf<Root.SegmentedViewOptions<Entry>>().toEqualTypeOf<SegmentedViewOptions<Entry>>();
    expectTypeOf<Matrix.StateViewOptions<string>>().toEqualTypeOf<StateViewOptions<string>>();
    // @ts-expect-error - the runtime's option shape is internal
    expectTypeOf<Matrix.RuntimeViewOptions>().toBeAny();
  });
});
