import type { AnySegmentedState, Segment, SegmentedState, SegmentOf } from './segmented-fold.js';

/**
 * Strategies trim a fold's state to a view's token budget (see `ContextFold#view`). A view runs
 * them in order, each at most once, and only while the state is over budget. They are pure: they
 * return a new state (or the same one when they change nothing) and never mutate their input.
 */

/**
 * What a strategy knows about the budget (its second argument): the view's numbers and its token
 * counter.
 */
export type ContextStrategyBudget<Unit> = {
  /** The view's budget, in tokens. */
  readonly budget: number;
  /** Tokens of the state passed to the strategy (for a segmented state: checkpoint included). */
  readonly tokens: number;
  /** The view's counter: per segment for a segmented state, else for the whole state. */
  readonly count: (unit: Unit) => number;
};

/** What a view's counter measures: one segment of a segmented state, else the whole state. */
export type CountUnitOf<State> = [State] extends [AnySegmentedState] ? SegmentOf<State> : State;

/**
 * A step of a view that shrinks a state toward the budget: `(state, { budget, tokens, count }) =>
 * state`. Pure: no I/O, no mutation, return `state` itself when nothing changes. Strategies over
 * a segmented state should drop or transform whole segments, never split one: a segment is an
 * atomic unit (e.g. a model step and all of its tool results). The built-in ones are on the
 * `ContextStrategy` object (`ContextStrategy.elide`, `ContextStrategy.dropOldest`); write your own
 * as a plain function of this type.
 */
export type ContextStrategy<State> = (
  state: State,
  context: ContextStrategyBudget<CountUnitOf<State>>,
) => State;

/**
 * A built-in strategy over segments with data `T`: usable as the `ContextStrategy` of any
 * segmented state with that data, whatever its checkpoint type, and of no other state.
 */
export type SegmentContextStrategy<T> = <State extends SegmentedState<T, unknown>>(
  state: State,
  context: ContextStrategyBudget<Segment<T>>,
) => State;

/** Options of `ContextStrategy.elide()`. */
export type ElideOptions<T> = {
  /** How many of the newest segments stay intact (a non-negative integer). */
  readonly olderThan: number;
  /** Which of the older segments to map (default: all of them); `index` is the position. */
  readonly where?: (segment: Segment<T>, index: number) => boolean;
  /** The elided data, e.g. a tool output cut to its first lines. Return `data` to keep it. */
  readonly map: (data: T, segment: Segment<T>) => T;
};

/** `ContextStrategy.elide` (documented there). */
function elide<T>(options: ElideOptions<T>): SegmentContextStrategy<T> {
  const { olderThan, where, map } = options;
  if (!Number.isSafeInteger(olderThan) || olderThan < 0) {
    throw new RangeError(
      `ContextStrategy.elide(): olderThan must be a non-negative integer; got ${olderThan}.`,
    );
  }
  return <State extends SegmentedState<T, unknown>>(state: State): State => {
    const old = state.segments.length - olderThan;
    let changed = false;
    const segments = state.segments.map((segment, index) => {
      if (index >= old || (where && !where(segment, index))) return segment;
      const data = map(segment.data, segment);
      if (Object.is(data, segment.data)) return segment;
      changed = true;
      return { ...segment, data };
    });
    return changed ? { ...state, segments } : state;
  };
}

/** Options of `ContextStrategy.dropOldest()`. */
export type DropOldestOptions<T> = {
  /**
   * Segments that are never dropped, e.g. those of the current turn. `index` is the segment's
   * position in `segments` (the state the strategy got).
   */
  readonly pin?: (
    segment: Segment<T>,
    index: number,
    segments: ReadonlyArray<Segment<T>>,
  ) => boolean;
};

/** `ContextStrategy.dropOldest` (documented there). */
function dropOldest<T>(options: DropOldestOptions<T> = {}): SegmentContextStrategy<T> {
  const { pin } = options;
  return <State extends SegmentedState<T, unknown>>(
    state: State,
    { budget, tokens, count }: ContextStrategyBudget<Segment<T>>,
  ): State => {
    const { segments } = state;
    let remaining = tokens;
    const dropped = new Set<number>();
    for (let index = 0; index < segments.length && remaining > budget; index++) {
      const segment = segments[index] as Segment<T>;
      if (pin?.(segment, index, segments)) continue;
      dropped.add(index);
      remaining -= count(segment);
    }
    if (dropped.size === 0) return state;
    return { ...state, segments: segments.filter((_, index) => !dropped.has(index)) };
  };
}

/**
 * The built-in context strategies, for a view of a `SegmentedFold` (`fold.view(name, { budget,
 * strategies })`): typed against segmented state, they never split a segment.
 *
 * - `elide({ olderThan, where?, map })` transforms the data of old segments (e.g. truncates old
 *   tool outputs) and never removes one;
 * - `dropOldest({ pin? })` drops whole segments, oldest first, never pinned ones, until the
 *   tokens fit.
 *
 * ```ts
 * const ChatView = Conversation.view('chat', {
 *   budget: 50_000,
 *   strategies: [
 *     ContextStrategy.elide({ olderThan: 6, map: truncateToolOutputs }),
 *     ContextStrategy.dropOldest({ pin: inCurrentTurn }),
 *   ],
 * });
 * ```
 *
 * A strategy is any pure `ContextStrategy<State>` function, so you can add your own to the list.
 */
export const ContextStrategy: {
  /**
   * Transforms the data of the segments older than the newest `olderThan` (those matching
   * `where`) with `map`, e.g. to truncate old tool outputs. Never removes a segment, and does not
   * check the budget itself: the view runs it only while over budget, and the next strategy only
   * if still over. Throws a `RangeError` when `olderThan` is not a non-negative integer.
   */
  readonly elide: <T>(options: ElideOptions<T>) => SegmentContextStrategy<T>;
  /**
   * Drops whole segments, oldest first, until the tokens fit the budget, skipping pinned ones.
   * When every remaining segment is pinned the state stays over budget (the view reports
   * `overBudget`). The checkpoint is never dropped; its tokens count toward the total.
   */
  readonly dropOldest: <T>(options?: DropOldestOptions<T>) => SegmentContextStrategy<T>;
} = Object.freeze({ elide, dropOldest });
