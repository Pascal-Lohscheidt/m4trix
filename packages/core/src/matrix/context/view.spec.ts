import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type * as Root from '../../index.js';
import * as root from '../../index.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import type * as Matrix from '../index.js';
import * as matrix from '../index.js';
import {
  ContextFold,
  ContextFoldDefinitionError,
  type FoldResultOf,
  type FoldSource,
} from './context-fold.js';
import { type Segment, SegmentedFold, type SegmentedState } from './segmented-fold.js';
import { ContextStrategy } from './strategies.js';
import {
  approxTokenCount,
  type ContextView,
  type SegmentedViewOptions,
  type StateViewOptions,
  type ViewOptions,
  type ViewResult,
} from './view.js';

/* ─── Fixtures ─── */

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const Compacted = AgentNetworkEvent.of('compacted', S.Struct({ summary: S.String }));

type Entry = { readonly kind: 'user' | 'tool'; readonly text: string };
type State = SegmentedState<Entry, string>;

/** A segmented fold: each prompt opens a segment named after its text. */
const notes = () =>
  SegmentedFold.of('notes', { version: 1 })
    .over([UserPrompt, Compacted])
    .segments<Entry, string>()
    .on(UserPrompt, (state, { payload }) =>
      SegmentedFold.open(state, payload.text, { kind: 'user', text: payload.text }),
    )
    .checkpointOn(Compacted, ({ payload }) => ({ checkpoint: payload.summary, segments: [] }));

const segment = (id: string, size: number, kind: Entry['kind'] = 'user'): Segment<Entry> => ({
  id,
  data: { kind, text: 'x'.repeat(size) },
});
const state = (sizes: Record<string, number>, checkpoint?: string): State => ({
  ...(checkpoint === undefined ? {} : { checkpoint }),
  segments: Object.entries(sizes).map(([id, size]) => segment(id, size)),
});
/** Deterministic counters: a segment counts its text length, the checkpoint its length. */
const count = (segment: Segment<Entry>) => segment.data.text.length;
const countCheckpoint = (summary: string) => summary.length;

/** Runs `build` and returns the `ContextFoldDefinitionError` it throws. */
function definitionError(build: () => unknown): ContextFoldDefinitionError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextFoldDefinitionError);
    return error as ContextFoldDefinitionError;
  }
  throw new Error('expected a ContextFoldDefinitionError');
}

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

describe('ContextFold#view of a segmented fold', () => {
  test('is a fold source: its own name, the base fold, select = strategies', () => {
    const fold = notes();
    const view = fold.view('chat', { budget: 100 });

    expect(view.name).toBe('chat');
    expect(view.fold).toBe(fold);
    expect(view.budget).toBe(100);
    expect(() => ContextFold.validate(view)).not.toThrow();
    expectTypeOf(view).toEqualTypeOf<ContextView<'chat', State>>();
    expectTypeOf(view).toExtend<FoldSource<'chat', ViewResult<State>>>();
    expectTypeOf<FoldResultOf<typeof view>>().toEqualTypeOf<ViewResult<State>>();
  });

  test('within budget no strategy runs: the state is returned as is', () => {
    const strategy = vi.fn<ContextStrategy<State>>((s) => s);
    const view = notes().view('chat', { budget: 30, count, strategies: [strategy] });
    const input = state({ a: 10, b: 20 });

    const result = view.select(input);

    expect(result).toEqual({
      state: input,
      tokens: 30,
      budget: 30,
      overBudget: false,
      dropped: [],
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
    const view = notes().view('chat', { budget: 25, count, strategies: [first, second] });

    const result = view.select(state({ a: 10, b: 10, c: 10 }));

    expect(calls).toEqual(['first 30/25']);
    expect(result).toEqual({
      state: state({ b: 10, c: 10 }),
      tokens: 20,
      budget: 25,
      overBudget: false,
      dropped: ['a'],
    });
  });

  test('each strategy runs at most once; still over budget afterwards → overBudget', () => {
    const tokensSeen: number[] = [];
    const dropFirst: ContextStrategy<State> = (s, { tokens }) => {
      tokensSeen.push(tokens);
      return { ...s, segments: s.segments.slice(1) };
    };
    const view = notes().view('chat', { budget: 5, count, strategies: [dropFirst, dropFirst] });

    const result = view.select(state({ a: 10, b: 10, c: 10 }));

    expect(tokensSeen).toEqual([30, 20]);
    expect(result.tokens).toBe(10);
    expect(result.overBudget).toBe(true);
    expect(result.dropped).toEqual(['a', 'b']);
  });

  test('strategies get the view counter; built-ins never split segments', () => {
    const view = notes().view('chat', {
      budget: 25,
      count,
      strategies: [
        ContextStrategy.elide({
          olderThan: 1,
          where: (segment) => segment.data.kind === 'tool',
          map: (data) => ({ ...data, text: 'cut' }),
        }),
        ContextStrategy.dropOldest({ pin: (segment) => segment.id === 'pinned' }),
      ],
    });
    const input: State = {
      segments: [
        segment('pinned', 10),
        segment('t1', 40, 'tool'),
        segment('u1', 10),
        segment('t2', 10, 'tool'),
      ],
    };

    const result = view.select(input);

    // elide: t1 40 → 3 (63 → 33 tokens), still over: dropOldest skips the pin, drops t1, u1.
    expect(result.state.segments.map((s) => s.id)).toEqual(['pinned', 't2']);
    expect(result.tokens).toBe(20);
    expect(result.dropped).toEqual(['t1', 'u1']);
    expect(input.segments[1]?.data.text).toHaveLength(40);
  });

  test('when every segment is pinned the view stays over budget', () => {
    const view = notes().view('chat', {
      budget: 10,
      count,
      strategies: [ContextStrategy.dropOldest({ pin: () => true })],
    });
    const input = state({ a: 10, b: 10 });

    const result = view.select(input);

    expect(result).toEqual({ state: input, tokens: 20, budget: 10, overBudget: true, dropped: [] });
  });

  test('the checkpoint counts toward the tokens (countCheckpoint, default approxTokenCount)', () => {
    const fold = notes();
    const counted = fold.view('chat', { budget: 100, count, countCheckpoint });
    const approximated = fold.view('chat', { budget: 100, count });
    const withSummary = state({ a: 10 }, 'summary of 21 letters');

    expect(counted.select(withSummary).tokens).toBe(10 + 21);
    expect(approximated.select(withSummary).tokens).toBe(
      10 + approxTokenCount('summary of 21 letters'),
    );
  });

  test('no checkpoint counts nothing; countCheckpoint is not called', () => {
    const spy = vi.fn(countCheckpoint);
    const view = notes().view('chat', { budget: 100, count, countCheckpoint: spy });

    expect(view.select(state({ a: 10 })).tokens).toBe(10);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a checkpoint over budget alone stays over budget: dropOldest never drops it', () => {
    const view = notes().view('chat', {
      budget: 10,
      count,
      countCheckpoint,
      strategies: [ContextStrategy.dropOldest()],
    });

    const result = view.select(state({ a: 10 }, 'a summary that is long'));

    expect(result.state).toEqual({ checkpoint: 'a summary that is long', segments: [] });
    expect(result.overBudget).toBe(true);
    expect(result.dropped).toEqual(['a']);
  });

  test('count defaults to approxTokenCount of each segment', () => {
    const view = notes().view('chat', { budget: 1000 });
    const input = state({ a: 10, b: 30 });

    expect(view.select(input).tokens).toBe(
      approxTokenCount(input.segments[0]) + approxTokenCount(input.segments[1]),
    );
  });

  test('an empty state counts 0 tokens and is within any budget', () => {
    const view = notes().view('chat', { budget: 1, strategies: [ContextStrategy.dropOldest()] });

    expect(view.select({ segments: [] })).toEqual({
      state: { segments: [] },
      tokens: 0,
      budget: 1,
      overBudget: false,
      dropped: [],
    });
  });

  test('an Infinity budget means no budget: strategies never run', () => {
    const strategy = vi.fn<ContextStrategy<State>>((s) => s);
    const view = notes().view('chat', { budget: Infinity, count, strategies: [strategy] });

    const result = view.select(state({ a: 1_000_000 }));

    expect(result.overBudget).toBe(false);
    expect(result.budget).toBe(Infinity);
    expect(strategy).not.toHaveBeenCalled();
  });

  test('counts each segment once per view: segments are immutable, counts are cached', () => {
    const counter = vi.fn(count);
    const view = notes().view('chat', {
      budget: 15,
      count: counter,
      strategies: [ContextStrategy.dropOldest()],
    });
    const input = state({ a: 10, b: 10 });

    view.select(input);
    view.select(input);
    view.select({ ...input, segments: [...input.segments, segment('c', 5)] });

    expect(counter.mock.calls.map(([s]) => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('dropped lists ids by occurrence: a repeated id kept once is dropped once', () => {
    const view = notes().view('chat', {
      budget: 10,
      count,
      strategies: [(s) => ({ ...s, segments: s.segments.slice(-1) })],
    });

    const result = view.select({ segments: [segment('a', 10), segment('a', 10), segment('b', 1)] });

    expect(result.dropped).toEqual(['a', 'a']);
    expect(view.select({ segments: [segment('a', 10), segment('a', 10)] }).dropped).toEqual(['a']);
  });

  test('the view reads the fold the runtime folds: select works on the folded state', () => {
    const fold = notes();
    const view = fold.view('recent', {
      budget: 6,
      count,
      strategies: [ContextStrategy.dropOldest()],
    });
    const meta = { runId: 'r', contextId: 'c' };

    const folded = fold.applyAll(fold.initialState(), [
      UserPrompt.makeBound(meta, { text: 'one' }),
      UserPrompt.makeBound(meta, { text: 'two' }),
      UserPrompt.makeBound(meta, { text: 'three' }),
    ]);

    expect(view.select(folded).state.segments.map((s) => s.id)).toEqual(['three']);
  });
});

describe('ContextFold#view of a non-segmented fold', () => {
  type Transcript = { readonly lines: readonly string[] };
  const transcript = () =>
    ContextFold.of('transcript', { version: 1 })
      .over([UserPrompt])
      .initial((): Transcript => ({ lines: [] }))
      .on(UserPrompt, (s, { payload }) => ({ lines: [...s.lines, payload.text] }));
  const measure = (s: Transcript) => s.lines.join('').length;

  test('counts the whole state with measure(state); strategies count with it too', () => {
    const keepLast: ContextStrategy<Transcript> = (s, { count, tokens, budget }) => {
      expectTypeOf(count).toEqualTypeOf<(state: Transcript) => number>();
      expect(count).toBe(measure);
      expect([tokens, budget]).toEqual([9, 5]);
      return { lines: s.lines.slice(-1) };
    };
    const view = transcript().view('short', { budget: 5, measure, strategies: [keepLast] });

    const result = view.select({ lines: ['abc', 'def', 'ghi'] });

    expect(result).toEqual({
      state: { lines: ['ghi'] },
      tokens: 3,
      budget: 5,
      overBudget: false,
      dropped: [],
    });
    expectTypeOf(view).toEqualTypeOf<ContextView<'short', Transcript>>();
  });

  test('strategies are optional: a view can only measure', () => {
    const view = transcript().view('size', { budget: 2, measure });

    expect(view.select({ lines: ['abc'] })).toMatchObject({ tokens: 3, overBudget: true });
  });

  test('needs measure(state): without segments there is nothing to count by default', () => {
    const fold = transcript();

    const error = definitionError(() =>
      // @ts-expect-error - a view of a non-segmented fold needs measure(state)
      fold.view('short', { budget: 5 }),
    );

    expect(error.foldName).toBe('transcript');
    expect(error.message).toBe(
      'ContextView "short" of fold "transcript": the fold state has no segments; pass ' +
        'measure(state) to count its tokens, or build the fold with SegmentedFold.',
    );
  });

  test('rejects segment strategies at type level', () => {
    const fold = transcript();

    void (() =>
      fold.view('short', {
        budget: 5,
        measure,
        // @ts-expect-error - built-in segment strategies need a segmented fold
        strategies: [ContextStrategy.dropOldest()],
      }));
    expect(fold.name).toBe('transcript');
  });
});

describe('ContextFold#view validation', () => {
  test.each([
    'chat-view',
    '',
    '1st',
    '__proto__',
  ])('rejects the view name %j: it becomes a ctx.folds property', (name) => {
    const error = definitionError(() => notes().view(name, { budget: 10 }));

    expect(error.foldName).toBe('notes');
    expect(error.message).toBe(
      `ContextView ${JSON.stringify(name)} of fold "notes": the name must be a JS identifier ` +
        '(letters, digits, `_` and `$`, not starting with a digit): it is the accessor name in ' +
        '`ctx.folds`.',
    );
  });

  test('rejects invalid literal names at type level', () => {
    const fold = notes();

    // @ts-expect-error - a view name must be a JS identifier
    void (() => fold.view('chat-view', { budget: 10 }));
    // @ts-expect-error - a view name must be a JS identifier
    void (() => fold.view('1st', { budget: 10 }));
    // @ts-expect-error - __proto__ would set the prototype of ctx.folds
    void (() => fold.view('__proto__', { budget: 10 }));
    const dynamic: string = 'chat';
    expect(fold.view(dynamic, { budget: 10 }).name).toBe('chat');
    expect(fold.view('$chat_V2', { budget: 10 }).name).toBe('$chat_V2');
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
  ])('rejects budget %s: a positive integer or Infinity', (budget) => {
    const error = definitionError(() => notes().view('chat', { budget }));

    expect(error.message).toBe(
      `ContextView "chat" of fold "notes": the budget must be a positive integer (tokens) or ` +
        `Infinity (no budget); got ${budget}.`,
    );
  });

  test('rejects strategies that are not functions', () => {
    const error = definitionError(() =>
      notes().view('chat', {
        budget: 10,
        // @ts-expect-error - a strategy is a function
        strategies: [ContextStrategy.dropOldest(), 'elide'],
      }),
    );

    expect(error.message).toBe(
      'ContextView "chat" of fold "notes": strategies must be functions ' +
        '(state, { budget, tokens, count }) => state.',
    );
  });

  test('is only available on complete folds', () => {
    const incomplete = SegmentedFold.of('notes', { version: 1 })
      .over([UserPrompt, Compacted])
      .segments<Entry, string>()
      .on(UserPrompt, (s) => s);

    const error = definitionError(() =>
      // @ts-expect-error - "compacted" has no handler yet: not callable
      incomplete.view('chat', { budget: 10 }),
    );

    expect(error.message).toContain('no handler for "compacted"');
  });

  test('views are independent of each other and of the fold', () => {
    const fold = notes();
    const small = fold.view('small', {
      budget: 10,
      count,
      strategies: [ContextStrategy.dropOldest()],
    });
    const large = fold.view('large', {
      budget: 100,
      count,
      strategies: [ContextStrategy.dropOldest()],
    });
    const input = state({ a: 10, b: 10 });

    expect(small.select(input).dropped).toEqual(['a']);
    expect(large.select(input).dropped).toEqual([]);
    expect(fold.select(input)).toBe(input);
  });
});

describe('view option types', () => {
  test('counters and strategies are typed from the fold state', () => {
    const view = notes().view('chat', {
      budget: 100,
      count: (segment) => {
        expectTypeOf(segment).toEqualTypeOf<Segment<Entry>>();
        return segment.data.text.length;
      },
      countCheckpoint: (summary) => {
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

    const result = view.select(state({ a: 1 }));
    expectTypeOf(result.state.segments).toEqualTypeOf<ReadonlyArray<Segment<Entry>>>();
    expectTypeOf(result.dropped).toEqualTypeOf<ReadonlyArray<string>>();
    expectTypeOf(result.overBudget).toEqualTypeOf<boolean>();
  });

  test('a segmented view takes no measure; a segment counter is not a state counter', () => {
    const fold = notes();

    // @ts-expect-error - segmented folds count per segment (count), not the whole state
    void (() => fold.view('chat', { budget: 10, measure: (s: State) => s.segments.length }));
    // @ts-expect-error - count gets a segment
    void (() => fold.view('chat', { budget: 10, count: (s: State) => s.segments.length }));
    expect(fold.name).toBe('notes');
  });
});

describe('exports', () => {
  test('views, their options and approxTokenCount are exported by name; internals are not', () => {
    for (const entry of [root, matrix]) {
      expect(entry.approxTokenCount).toBe(approxTokenCount);
      for (const internal of ['approxTokens', 'createView', 'isSegmentedState']) {
        expect(entry).not.toHaveProperty(internal);
      }
    }
    expectTypeOf<Root.ContextView<'chat', State>>().toEqualTypeOf<ContextView<'chat', State>>();
    expectTypeOf<Matrix.ContextView<'chat', State>>().toEqualTypeOf<ContextView<'chat', State>>();
    expectTypeOf<Root.ViewResult<State>>().toEqualTypeOf<ViewResult<State>>();
    expectTypeOf<Matrix.ViewResult<State>>().toEqualTypeOf<ViewResult<State>>();
    expectTypeOf<Root.ViewOptions<State>>().toEqualTypeOf<SegmentedViewOptions<State>>();
    expectTypeOf<Matrix.ViewOptions<string>>().toEqualTypeOf<StateViewOptions<string>>();
    expectTypeOf<Root.ViewOptions<string>>().toEqualTypeOf<ViewOptions<string>>();
    expectTypeOf<Root.SegmentedViewOptions<State>>().toEqualTypeOf<SegmentedViewOptions<State>>();
    expectTypeOf<Matrix.SegmentedViewOptions<State>>().toEqualTypeOf<SegmentedViewOptions<State>>();
    expectTypeOf<Root.StateViewOptions<string>>().toEqualTypeOf<StateViewOptions<string>>();
    expectTypeOf<Matrix.StateViewOptions<string>>().toEqualTypeOf<StateViewOptions<string>>();
    // @ts-expect-error - the runtime's option shape is internal
    expectTypeOf<Root.RuntimeViewOptions>().toBeAny();
    // @ts-expect-error - the runtime's option shape is internal
    expectTypeOf<Matrix.RuntimeViewOptions>().toBeAny();
  });
});
