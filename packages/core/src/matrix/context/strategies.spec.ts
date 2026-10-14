import { describe, expect, expectTypeOf, test } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import type { Segment, SegmentedState } from './segmented-fold.js';
import {
  ContextStrategy,
  type ContextStrategyBudget,
  type CountUnitOf,
  type DropOldestOptions,
  type ElideOptions,
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

/** Every segment counts 10 tokens, the checkpoint 5. */
const count = (_segment: Segment<Entry>) => 10;
const context = (budget: number, state: State): ContextStrategyBudget<Segment<Entry>> => ({
  budget,
  count,
  tokens: (state.checkpoint === undefined ? 0 : 5) + state.segments.length * 10,
});
const run = (strategy: ContextStrategy<State>, budget: number, state: State) =>
  strategy(state, context(budget, state));

const ids = (state: State) => state.segments.map((segment) => segment.id);

describe('ContextStrategy', () => {
  test('namespaces the built-in strategies: elide and dropOldest, nothing else, frozen', () => {
    expect(Object.keys(ContextStrategy).sort()).toEqual(['dropOldest', 'elide']);
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
    olderThan: 2,
    map: (data) => (data.kind === 'tool' ? { ...data, output: '[elided]' } : data),
  });

  test('maps the data of every segment but the newest `olderThan`, never removing one', () => {
    const state: State = {
      checkpoint: 'summary',
      segments: [tool('t1', 'long'), user('u1', 'q'), tool('t2', 'long'), tool('t3', 'new')],
    };

    const next = run(truncate, 0, state);

    expect(next).toEqual({
      checkpoint: 'summary',
      segments: [tool('t1', '[elided]'), user('u1', 'q'), tool('t2', 'long'), tool('t3', 'new')],
    });
    expect(next.segments[1]).toBe(state.segments[1]);
    expect(next.segments[2]).toBe(state.segments[2]);
  });

  test('`where` selects which old segments are mapped; map and where get the typed segment', () => {
    const seen: Array<[string, number]> = [];
    const strategy = ContextStrategy.elide<Entry>({
      olderThan: 0,
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
    const unchanged = ContextStrategy.elide<Entry>({ olderThan: 0, map: (data) => data });

    expect(run(truncate, 0, state)).toBe(state);
    expect(run(unchanged, 0, state)).toBe(state);
    expect(run(truncate, 0, { segments: [] }).segments).toEqual([]);
  });

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects olderThan %s: it must be a non-negative integer', (olderThan) => {
    expect(() => ContextStrategy.elide<Entry>({ olderThan, map: (data) => data })).toThrow(
      RangeError,
    );
    expect(() => ContextStrategy.elide<Entry>({ olderThan, map: (data) => data })).toThrow(
      `ContextStrategy.elide(): olderThan must be a non-negative integer; got ${olderThan}.`,
    );
  });
});

describe('ContextStrategy.dropOldest', () => {
  test('drops whole segments, oldest first, until the tokens fit the budget', () => {
    const state: State = {
      checkpoint: 'summary',
      segments: [user('u1', 'a'), tool('t1', 'b'), user('u2', 'c'), tool('t2', 'd')],
    };

    // 45 tokens (5 checkpoint + 4 × 10): dropping two segments reaches 25.
    const next = run(ContextStrategy.dropOldest(), 25, state);

    expect(next).toEqual({ checkpoint: 'summary', segments: [user('u2', 'c'), tool('t2', 'd')] });
  });

  test('never drops pinned segments; pin gets the typed segment, its index and all segments', () => {
    const state: State = {
      segments: [user('u1', 'a'), tool('t1', 'b'), user('u2', 'c'), tool('t2', 'd')],
    };
    const strategy = ContextStrategy.dropOldest<Entry>({
      pin: (segment, index, segments) => {
        expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
        expectTypeOf(index).toEqualTypeOf<number>();
        expectTypeOf(segments).toEqualTypeOf<ReadonlyArray<Segment<Entry>>>();
        expect(segments).toBe(state.segments);
        return segment.data.kind === 'user';
      },
    });

    expect(ids(run(strategy, 30, state))).toEqual(['u1', 'u2', 't2']);
    expect(ids(run(strategy, 0, state))).toEqual(['u1', 'u2']);
  });

  test('returns the same state when within budget or when every segment is pinned', () => {
    const state: State = { segments: [user('u1', 'a'), user('u2', 'b')] };

    expect(run(ContextStrategy.dropOldest(), 20, state)).toBe(state);
    expect(run(ContextStrategy.dropOldest<Entry>({ pin: () => true }), 0, state)).toBe(state);
    expect(run(ContextStrategy.dropOldest(), 0, { segments: [] }).segments).toEqual([]);
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
});

describe('strategy types', () => {
  test('built-in strategies infer the segment data type from where they are used', () => {
    const strategies: ReadonlyArray<ContextStrategy<State>> = [
      ContextStrategy.elide({
        olderThan: 1,
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
        pin: (segment) => {
          expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
          return segment.data.kind === 'user';
        },
      }),
    ];

    expect(strategies).toHaveLength(2);
  });

  test('a segment strategy fits any checkpoint type, but only segmented states', () => {
    type Conversation = { readonly turns: readonly string[] };
    const strategy: SegmentContextStrategy<Entry> = ContextStrategy.dropOldest();

    const withSummary: ContextStrategy<State> = strategy;
    const withoutCheckpoint: ContextStrategy<SegmentedState<Entry>> = strategy;
    // @ts-expect-error - a segment strategy needs a segmented state
    const notSegmented: ContextStrategy<Conversation> = strategy;
    // @ts-expect-error - the segment data types differ
    const otherData: ContextStrategy<SegmentedState<number>> = strategy;
    void [withSummary, withoutCheckpoint, notSegmented, otherData];
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
});

describe('exports', () => {
  test('ContextStrategy (value and type) is exported by name; the bare strategies are not', () => {
    for (const entry of [root, matrix]) {
      expect(entry.ContextStrategy).toBe(ContextStrategy);
      for (const internal of ['elide', 'dropOldest', 'Strategy', 'SegmentStrategy']) {
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
  });
});
