import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import { ContextFold } from './context-fold.js';
import { type Segment, SegmentedFold, type SegmentedState } from './segmented-fold.js';
import {
  ContextStrategy,
  type ContextStrategyBudget,
  type CountUnitOf,
  type DropOldestOptions,
  type ElideOptions,
  type KeepFrom,
  type SegmentContextStrategy,
} from './strategies.js';

/* ─── Fixtures ─── */

type Entry =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'tool'; readonly output: string };
type State = SegmentedState<Entry, string>;

const user = (id: string, text: string): Segment<Entry> => ({ id, data: { kind: 'user', text } });
const tool = (id: string, output: string): Segment<Entry> => ({
  id,
  data: { kind: 'tool', output },
});

/** Every segment counts 10 tokens, the summary 5. */
const count = (_segment: Segment<Entry>) => 10;
const context = (budget: number, state: State): ContextStrategyBudget<Segment<Entry>> => ({
  budget,
  count,
  tokens: (state.summary === undefined ? 0 : 5) + state.segments.length * 10,
});
const run = (strategy: ContextStrategy<State>, budget: number, state: State) =>
  strategy(state, context(budget, state));

const ids = (state: State) => state.segments.map((segment) => segment.id);

/** A segmented fold of `Entry` data, tagged by `kind` (fromNewest reads the kind with it). */
const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const EntrySchema = S.Union(
  S.Struct({ kind: S.Literal('user'), text: S.String }),
  S.Struct({ kind: S.Literal('tool'), output: S.String }),
);
const Notes = SegmentedFold.of('notes', {
  data: EntrySchema,
  summary: S.String,
  tag: 'kind',
}).open(UserPrompt, ({ payload }) => ({
  id: payload.text,
  data: { kind: 'user', text: payload.text },
}));

describe('ContextStrategy', () => {
  test('namespaces the built-in strategies and the keepFrom helpers, nothing else, frozen', () => {
    expect(Object.keys(ContextStrategy).sort()).toEqual([
      'dropOldest',
      'elide',
      'fromNewest',
      'newest',
    ]);
    expect(Object.isFrozen(ContextStrategy)).toBe(true);
    expectTypeOf(ContextStrategy.elide<Entry>).parameters.toEqualTypeOf<[ElideOptions<Entry>]>();
    expectTypeOf(ContextStrategy.elide<Entry>).returns.toEqualTypeOf<
      SegmentContextStrategy<Entry>
    >();
    expectTypeOf(ContextStrategy.dropOldest<Entry>).parameters.toEqualTypeOf<
      [options?: DropOldestOptions<Entry>]
    >();
    expectTypeOf(ContextStrategy.dropOldest<Entry>).returns.toEqualTypeOf<
      SegmentContextStrategy<Entry>
    >();
  });

  test('the ContextStrategy type is a strategy: (state, budget context) => state', () => {
    expectTypeOf<ContextStrategy<State>>().toEqualTypeOf<
      (state: State, context: ContextStrategyBudget<Segment<Entry>>) => State
    >();
    expectTypeOf<ContextStrategy<string>>().toEqualTypeOf<
      (state: string, context: ContextStrategyBudget<string>) => string
    >();
    expectTypeOf(ContextStrategy.dropOldest<Entry>()).toExtend<ContextStrategy<State>>();
  });
});

describe('ContextStrategy.elide', () => {
  const truncate = ContextStrategy.elide<Entry>({
    keepNewest: 2,
    map: (data) => (data.kind === 'tool' ? { ...data, output: '[elided]' } : data),
  });

  test('maps the data of every segment but the newest `keepNewest`, never removing one', () => {
    const state: State = {
      summary: 'summary',
      segments: [tool('t1', 'long'), user('u1', 'q'), tool('t2', 'long'), tool('t3', 'new')],
    };

    const next = run(truncate, 0, state);

    expect(next).toEqual({
      summary: 'summary',
      segments: [tool('t1', '[elided]'), user('u1', 'q'), tool('t2', 'long'), tool('t3', 'new')],
    });
    expect(next.segments[1]).toBe(state.segments[1]);
    expect(next.segments[2]).toBe(state.segments[2]);
  });

  test('`where` selects which old segments are mapped; map and where get the typed segment', () => {
    const seen: Array<[string, number]> = [];
    const strategy = ContextStrategy.elide<Entry>({
      keepNewest: 0,
      where: (segment, index) => {
        expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
        seen.push([segment.id, index]);
        return segment.id !== 't2';
      },
      map: (data, segment) => {
        expectTypeOf(data).toEqualTypeOf<Entry>();
        expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
        return data.kind === 'tool' ? { ...data, output: `${segment.id} elided` } : data;
      },
    });

    const next = run(strategy, 0, { segments: [tool('t1', 'a'), tool('t2', 'b')] });

    expect(seen).toEqual([
      ['t1', 0],
      ['t2', 1],
    ]);
    expect(next.segments).toEqual([tool('t1', 't1 elided'), tool('t2', 'b')]);
  });

  test('returns the same state when nothing is old enough or nothing changes', () => {
    const state: State = { segments: [tool('t1', 'a'), tool('t2', 'b')] };
    const unchanged = ContextStrategy.elide<Entry>({ keepNewest: 0, map: (data) => data });

    expect(run(truncate, 0, state)).toBe(state);
    expect(run(unchanged, 0, state)).toBe(state);
    expect(run(truncate, 0, { segments: [] }).segments).toEqual([]);
  });

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
  ])('rejects keepNewest %s: it must be a non-negative integer', (keepNewest) => {
    const elide = () =>
      ContextStrategy.elide<Entry>({ keepNewest: keepNewest as number, map: (data) => data });

    expect(elide).toThrow(RangeError);
    expect(elide).toThrow(
      `ContextStrategy.elide(): keepNewest must be a non-negative integer; got ${keepNewest}.`,
    );
  });

  test('reuses the elided segment per source segment: the same old segment elides to one object', () => {
    const map = vi.fn((data: Entry) =>
      data.kind === 'tool' ? { ...data, output: '[elided]' } : data,
    );
    const strategy = ContextStrategy.elide<Entry>({ keepNewest: 1, map });
    const state: State = { segments: [tool('t1', 'a'), user('u1', 'q'), tool('t2', 'b')] };

    const first = run(strategy, 0, state);
    const second = run(strategy, 0, { segments: [...state.segments, tool('t3', 'c')] });

    expect(first.segments[0]).toEqual(tool('t1', '[elided]'));
    expect(second.segments[0]).toBe(first.segments[0]);
    // Unchanged data stays the segment itself; t2 is old now and elided once.
    expect(second.segments[1]).toBe(state.segments[1]);
    expect(second.segments[2]).toEqual(tool('t2', '[elided]'));
    expect(map.mock.calls.map(([data]) => data)).toEqual([
      state.segments[0]?.data,
      state.segments[1]?.data,
      state.segments[2]?.data,
    ]);
    // Another elide() has its own memo.
    const other = ContextStrategy.elide<Entry>({ keepNewest: 1, map });
    expect(run(other, 0, state).segments[0]).not.toBe(first.segments[0]);
  });
});

describe('ContextStrategy.dropOldest', () => {
  test('drops whole segments, oldest first, until the tokens fit the budget', () => {
    const state: State = {
      summary: 'summary',
      segments: [user('u1', 'a'), tool('t1', 'b'), user('u2', 'c'), tool('t2', 'd')],
    };

    // 45 tokens (5 summary + 4 × 10): dropping two segments reaches 25.
    const next = run(ContextStrategy.dropOldest(), 25, state);

    expect(next).toEqual({ summary: 'summary', segments: [user('u2', 'c'), tool('t2', 'd')] });
  });

  test('never drops the segments from keepFrom(segments) on; keepFrom runs once per call', () => {
    const state: State = {
      segments: [user('u1', 'a'), tool('t1', 'b'), user('u2', 'c'), tool('t2', 'd')],
    };
    const keepFrom = vi.fn((segments: ReadonlyArray<Segment<Entry>>) => {
      expect(segments).toBe(state.segments);
      return 2;
    });
    const strategy = ContextStrategy.dropOldest<Entry>({ keepFrom });

    expect(ids(run(strategy, 30, state))).toEqual(['t1', 'u2', 't2']);
    expect(ids(run(strategy, 0, state))).toEqual(['u2', 't2']);
    expect(keepFrom).toHaveBeenCalledTimes(2);
  });

  test('returns the same state when within budget or when nothing may be dropped', () => {
    const state: State = { segments: [user('u1', 'a'), user('u2', 'b')] };

    expect(run(ContextStrategy.dropOldest(), 20, state)).toBe(state);
    expect(run(ContextStrategy.dropOldest<Entry>({ keepFrom: () => 0 }), 0, state)).toBe(state);
    expect(run(ContextStrategy.dropOldest(), 0, { segments: [] }).segments).toEqual([]);
  });

  test('keepFrom equal to the number of segments keeps none: everything may go', () => {
    const state: State = { segments: [user('u1', 'a'), user('u2', 'b')] };
    const strategy = ContextStrategy.dropOldest<Entry>({ keepFrom: (s) => s.length });

    expect(run(strategy, 0, state).segments).toEqual([]);
  });

  test('uses the injected count per segment', () => {
    const state: State = { segments: [tool('big', 'x'.repeat(100)), user('u1', 'a')] };
    const sized = (segment: Segment<Entry>) => (segment.id === 'big' ? 100 : 1);

    const next = ContextStrategy.dropOldest<Entry>()(state, {
      budget: 50,
      tokens: 101,
      count: sized,
    });

    expect(ids(next)).toEqual(['u1']);
  });

  test.each([
    -1,
    3,
    1.5,
    Number.NaN,
  ])('rejects a keepFrom index %s: an integer from 0 to the number of segments', (index) => {
    const state: State = { segments: [user('u1', 'a'), user('u2', 'b')] };
    const strategy = ContextStrategy.dropOldest<Entry>({ keepFrom: () => index });

    expect(() => run(strategy, 0, state)).toThrow(
      new RangeError(
        'ContextStrategy.dropOldest(): keepFrom must return an index from 0 to 2 (the number of ' +
          `segments); got ${index}.`,
      ),
    );
  });

  test('rejects a keepFrom that is not a function', () => {
    expect(() =>
      // @ts-expect-error - keepFrom is a function of the segments
      ContextStrategy.dropOldest<Entry>({ keepFrom: 2 }),
    ).toThrow(
      new TypeError(
        'ContextStrategy.dropOldest(): keepFrom must be a function (segments) => index.',
      ),
    );
  });
});

describe('ContextStrategy.fromNewest', () => {
  test("keepFrom of the newest segment of a kind, read with the fold's tag", () => {
    const fromUser = ContextStrategy.fromNewest(Notes, 'user');

    expect(fromUser([user('u1', 'a'), tool('t1', 'b'), user('u2', 'c'), tool('t2', 'd')])).toBe(2);
    expect(fromUser([user('u1', 'a')])).toBe(0);
    expect(ContextStrategy.fromNewest(Notes, 'tool')([tool('t1', 'b'), user('u2', 'c')])).toBe(0);
    expectTypeOf(fromUser).toEqualTypeOf<KeepFrom<Entry>>();
  });

  test('without a segment of that kind, every segment is newer: 0 (keep them all)', () => {
    const fromTool = ContextStrategy.fromNewest(Notes, 'tool');

    expect(fromTool([user('u1', 'a'), user('u2', 'b')])).toBe(0);
    expect(fromTool([])).toBe(0);
  });

  test('keeps the current turn in dropOldest: from the newest user prompt on', () => {
    const state: State = {
      segments: [user('u1', 'a'), tool('t1', 'b'), user('u2', 'c'), tool('t2', 'd')],
    };
    const strategy = ContextStrategy.dropOldest({
      keepFrom: ContextStrategy.fromNewest(Notes, 'user'),
    });

    expect(ids(run(strategy, 0, state))).toEqual(['u2', 't2']);
  });

  test("the kind is typed by the fold's tag", () => {
    // @ts-expect-error - 'answer' is not a kind of Notes
    void (() => ContextStrategy.fromNewest(Notes, 'answer'));
    const untagged = SegmentedFold.of('untagged', { data: EntrySchema });
    // @ts-expect-error - its tag ('_tag') does not tell the variants apart: there are no kinds
    void (() => ContextStrategy.fromNewest(untagged, 'user'));
    const plain = ContextFold.of('plain')
      .initial((): SegmentedState<Entry> => ({ segments: [] }))
      .on(UserPrompt, (s) => s);
    // @ts-expect-error - a ContextFold has no tag, even with a segmented state
    void (() => ContextStrategy.fromNewest(plain, 'user'));
    expect(untagged.tag).toBe('_tag');
  });

  test('rejects what is not a segmented fold or a kind', () => {
    const plain = ContextFold.of('plain')
      .initial(() => 0)
      .on(UserPrompt, (n) => n + 1);
    const error = new TypeError(
      "ContextStrategy.fromNewest() needs a SegmentedFold and one of its kinds, e.g. fromNewest(Conversation, 'user').",
    );

    // @ts-expect-error - a ContextFold has no segments
    expect(() => ContextStrategy.fromNewest(plain, 'user')).toThrow(error);
    // @ts-expect-error - a kind is a string
    expect(() => ContextStrategy.fromNewest(Notes, 1)).toThrow(error);
  });

  test('data without the tag (or not an object) is of no kind', () => {
    const fromUser = ContextStrategy.fromNewest(Notes, 'user');
    const odd = [{ id: 'x', data: null }, user('u1', 'a'), { id: 'y', data: 'text' }];

    expect(fromUser(odd as unknown as ReadonlyArray<Segment<Entry>>)).toBe(1);
  });
});

describe('ContextStrategy.newest', () => {
  test('keepFrom of the newest `count` segments (default 1); fewer segments: all of them', () => {
    const segments = [user('u1', 'a'), tool('t1', 'b'), user('u2', 'c')];

    expect(ContextStrategy.newest()(segments)).toBe(2);
    expect(ContextStrategy.newest(2)(segments)).toBe(1);
    expect(ContextStrategy.newest(0)(segments)).toBe(3);
    expect(ContextStrategy.newest(5)(segments)).toBe(0);
    expect(ContextStrategy.newest()([])).toBe(0);
  });

  test('keeps the newest segment in dropOldest, whatever its size', () => {
    const state: State = { segments: [user('u1', 'a'), tool('t1', 'b'), user('u2', 'c')] };
    const strategy = ContextStrategy.dropOldest<Entry>({ keepFrom: ContextStrategy.newest() });

    expect(ids(run(strategy, 0, state))).toEqual(['u2']);
  });

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects count %s: a non-negative integer', (count) => {
    expect(() => ContextStrategy.newest(count)).toThrow(
      new RangeError(
        `ContextStrategy.newest(): count must be a non-negative integer; got ${count}.`,
      ),
    );
  });

  test('is typed by where it is used: any segment data', () => {
    const strategies: ReadonlyArray<ContextStrategy<State>> = [
      ContextStrategy.dropOldest({ keepFrom: ContextStrategy.newest() }),
    ];
    const options: DropOldestOptions<Entry> = { keepFrom: ContextStrategy.newest(2) };

    expectTypeOf(ContextStrategy.newest<Entry>()).toEqualTypeOf<KeepFrom<Entry>>();
    expect([strategies, options]).toHaveLength(2);
  });
});

describe('strategy types', () => {
  test('built-in strategies infer the segment data type from where they are used', () => {
    const strategies: ReadonlyArray<ContextStrategy<State>> = [
      ContextStrategy.elide({
        keepNewest: 1,
        where: (segment) => {
          expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
          return true;
        },
        map: (data) => {
          expectTypeOf(data).toEqualTypeOf<Entry>();
          return data;
        },
      }),
      ContextStrategy.dropOldest({
        keepFrom: (segments) => {
          expectTypeOf(segments).toEqualTypeOf<ReadonlyArray<Segment<Entry>>>();
          return segments.length;
        },
      }),
      ContextStrategy.dropOldest({ keepFrom: ContextStrategy.fromNewest(Notes, 'user') }),
    ];

    expect(strategies).toHaveLength(3);
  });

  test('a segment strategy fits any summary type, but only segmented states', () => {
    type Conversation = { readonly turns: readonly string[] };
    const strategy: SegmentContextStrategy<Entry> = ContextStrategy.dropOldest();

    const withSummary: ContextStrategy<State> = strategy;
    const withoutSummary: ContextStrategy<SegmentedState<Entry>> = strategy;
    // @ts-expect-error - a segment strategy needs a segmented state
    const notSegmented: ContextStrategy<Conversation> = strategy;
    // @ts-expect-error - the segment data types differ
    const otherData: ContextStrategy<SegmentedState<number>> = strategy;
    void [withSummary, withoutSummary, notSegmented, otherData];
    expect(strategy).toBeTypeOf('function');
  });

  test('users write strategies: segmented ones count segments, others the whole state', () => {
    const keepLast: ContextStrategy<State> = (state, { budget, tokens, count }) => {
      expectTypeOf(count).toEqualTypeOf<(segment: Segment<Entry>) => number>();
      expectTypeOf(budget).toEqualTypeOf<number>();
      expectTypeOf(tokens).toEqualTypeOf<number>();
      return { ...state, segments: state.segments.slice(-1) };
    };
    const shorten: ContextStrategy<string> = (text, { budget, count }) => {
      expectTypeOf(count).toEqualTypeOf<(state: string) => number>();
      return count(text) > budget ? text.slice(0, budget) : text;
    };

    expect(ids(run(keepLast, 0, { segments: [user('a', ''), user('b', '')] }))).toEqual(['b']);
    expect(shorten('abcdef', { budget: 3, tokens: 6, count: (text) => text.length })).toBe('abc');
  });

  test('KeepFrom: the segments in, an index out', () => {
    expectTypeOf<KeepFrom<Entry>>().toEqualTypeOf<
      (segments: ReadonlyArray<Segment<Entry>>) => number
    >();
    expectTypeOf<DropOldestOptions<Entry>>().toEqualTypeOf<{
      readonly keepFrom?: KeepFrom<Entry>;
    }>();
  });
});

describe('exports', () => {
  test('ContextStrategy (value and type) is exported by name; the bare strategies are not', () => {
    for (const entry of [root, matrix]) {
      expect(entry.ContextStrategy).toBe(ContextStrategy);
      for (const internal of [
        'elide',
        'dropOldest',
        'fromNewest',
        'keepFromIndex',
        'Strategy',
        'SegmentStrategy',
      ]) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
    expectTypeOf<Root.ContextStrategy<State>>().toEqualTypeOf<ContextStrategy<State>>();
    expectTypeOf<Matrix.ContextStrategy<State>>().toEqualTypeOf<ContextStrategy<State>>();
    expectTypeOf<Root.SegmentContextStrategy<Entry>>().toEqualTypeOf<
      SegmentContextStrategy<Entry>
    >();
    expectTypeOf<Matrix.SegmentContextStrategy<Entry>>().toEqualTypeOf<
      SegmentContextStrategy<Entry>
    >();
    expectTypeOf<Root.ContextStrategyBudget<string>>().toEqualTypeOf<
      ContextStrategyBudget<string>
    >();
    expectTypeOf<Matrix.ContextStrategyBudget<string>>().toEqualTypeOf<
      ContextStrategyBudget<string>
    >();
    expectTypeOf<Root.CountUnitOf<State>>().toEqualTypeOf<CountUnitOf<State>>();
    expectTypeOf<Matrix.CountUnitOf<string>>().toEqualTypeOf<string>();
    expectTypeOf<Root.ElideOptions<Entry>>().toEqualTypeOf<ElideOptions<Entry>>();
    expectTypeOf<Matrix.ElideOptions<Entry>>().toEqualTypeOf<ElideOptions<Entry>>();
    expectTypeOf<Root.DropOldestOptions<Entry>>().toEqualTypeOf<DropOldestOptions<Entry>>();
    expectTypeOf<Matrix.DropOldestOptions<Entry>>().toEqualTypeOf<DropOldestOptions<Entry>>();
    expectTypeOf<Root.KeepFrom<Entry>>().toEqualTypeOf<KeepFrom<Entry>>();
    expectTypeOf<Matrix.KeepFrom<Entry>>().toEqualTypeOf<KeepFrom<Entry>>();
  });
});
