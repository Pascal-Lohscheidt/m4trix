import {
  type AnySegmentedFold,
  type AnySegmentedState,
  isSegmentedFold,
  type Segment,
  type SegmentedState,
  type SegmentKindOf,
  type SegmentOf,
} from './segmented-fold.js';

/**
 * Strategies trim a fold's state to a view's token budget (see `ContextView.of`). A view runs
 * them in order, each at most once, and only while the state is over budget. They are pure: they
 * return a new state (or the same one when they change nothing) and never mutate their input.
 */

/**
 * What a strategy knows about the budget (its second argument): the numbers of the read and the
 * view's token counter.
 */
export type ContextStrategyBudget<Unit> = {
  /** The budget of the read, in tokens. */
  readonly budget: number;
  /** Tokens of the state passed to the strategy (for a segmented state: summary included). */
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
 * segmented state with that data, whatever its summary type, and of no other state.
 */
export type SegmentContextStrategy<T> = <State extends SegmentedState<T, unknown>>(
  state: State,
  context: ContextStrategyBudget<Segment<T>>,
) => State;

/**
 * Where the segments that must stay begin: the index of the first one, from 0 (all stay) to
 * `segments.length` (none has to). Called once per use with the segments, oldest first, e.g.
 * `ContextStrategy.fromNewest(Conversation, 'user')` for the current turn.
 */
export type KeepFrom<T> = (segments: ReadonlyArray<Segment<T>>) => number;

/**
 * @internal `keepFrom(segments)`, checked: an integer from 0 to `segments.length`, else a
 * `RangeError` prefixed with `label`.
 */
export function keepFromIndex<T>(
  label: string,
  keepFrom: KeepFrom<T>,
  segments: ReadonlyArray<Segment<T>>,
): number {
  const index = keepFrom(segments);
  if (Number.isInteger(index) && index >= 0 && index <= segments.length) return index;
  throw new RangeError(
    `${label}: keepFrom must return an index from 0 to ${segments.length} (the number of ` +
      `segments); got ${index}.`,
  );
}

/** Options of `ContextStrategy.elide()`. */
export type ElideOptions<T> = {
  /** How many of the newest segments stay intact (a non-negative integer). */
  readonly keepNewest: number;
  /** Which of the older segments to map (default: all of them); `index` is the position. */
  readonly where?: (segment: Segment<T>, index: number) => boolean;
  /** The elided data, e.g. a tool output cut to its first lines. Return `data` to keep it. */
  readonly map: (data: T, segment: Segment<T>) => T;
};

/** `ContextStrategy.elide` (documented there). */
function elide<T>(options: ElideOptions<T>): SegmentContextStrategy<T> {
  const { keepNewest, where, map } = options;
  if (!Number.isSafeInteger(keepNewest) || keepNewest < 0) {
    throw new RangeError(
      `ContextStrategy.elide(): keepNewest must be a non-negative integer; got ${keepNewest}.`,
    );
  }
  // Each old segment elides to one object, on every read: so the view's count cache (per segment
  // object) keeps hitting, and `map` runs once per segment. Segments are immutable, `map` is pure.
  const elided = new WeakMap<Segment<T>, Segment<T>>();
  const elideSegment = (segment: Segment<T>): Segment<T> => {
    let result = elided.get(segment);
    if (result === undefined) {
      const data = map(segment.data, segment);
      result = Object.is(data, segment.data) ? segment : { ...segment, data };
      elided.set(segment, result);
    }
    return result;
  };
  return <State extends SegmentedState<T, unknown>>(state: State): State => {
    const old = state.segments.length - keepNewest;
    let changed = false;
    const segments = state.segments.map((segment, index) => {
      if (index >= old || (where && !where(segment, index))) return segment;
      const next = elideSegment(segment);
      if (next !== segment) changed = true;
      return next;
    });
    return changed ? { ...state, segments } : state;
  };
}

/** Options of `ContextStrategy.dropOldest()`. */
export type DropOldestOptions<T> = {
  /**
   * The segments from this index on are never dropped, e.g. those of the current turn
   * (`ContextStrategy.fromNewest(Conversation, 'user')`). Called once per read with the segments
   * the strategy got. Default: any segment may be dropped.
   */
  readonly keepFrom?: KeepFrom<T>;
};

/** `ContextStrategy.dropOldest` (documented there). */
function dropOldest<T>(options: DropOldestOptions<T> = {}): SegmentContextStrategy<T> {
  const { keepFrom } = options;
  if (keepFrom !== undefined && typeof keepFrom !== 'function') {
    throw new TypeError(
      'ContextStrategy.dropOldest(): keepFrom must be a function (segments) => index.',
    );
  }
  return <State extends SegmentedState<T, unknown>>(
    state: State,
    { budget, tokens, count }: ContextStrategyBudget<Segment<T>>,
  ): State => {
    const { segments } = state;
    const end = keepFrom
      ? keepFromIndex('ContextStrategy.dropOldest()', keepFrom, segments)
      : segments.length;
    let remaining = tokens;
    let cut = 0;
    while (cut < end && remaining > budget) {
      remaining -= count(segments[cut] as Segment<T>);
      cut++;
    }
    return cut === 0 ? state : { ...state, segments: segments.slice(cut) };
  };
}

/** `ContextStrategy.newest` (documented there). */
function newest<T>(count = 1): KeepFrom<T> {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(
      `ContextStrategy.newest(): count must be a non-negative integer; got ${count}.`,
    );
  }
  return (segments) => Math.max(0, segments.length - count);
}

/** `ContextStrategy.fromNewest` (documented there). */
function fromNewest<Data, Tag extends string>(
  fold: AnySegmentedFold<Data, Tag>,
  kind: SegmentKindOf<Data, Tag>,
): KeepFrom<Data> {
  if (!isSegmentedFold(fold) || typeof kind !== 'string') {
    throw new TypeError(
      'ContextStrategy.fromNewest() needs a SegmentedFold and one of its kinds, e.g. ' +
        "fromNewest(Conversation, 'user').",
    );
  }
  const { tag } = fold;
  return (segments) => {
    for (let index = segments.length - 1; index >= 0; index--) {
      // `Object()`: data that is not an object (a string, null) has no tag, so no kind.
      const data = Object((segments[index] as Segment<unknown>).data) as Record<string, unknown>;
      if (data[tag] === kind) return index;
    }
    return 0;
  };
}

/**
 * The built-in context strategies, for a view of a `SegmentedFold` (`ContextView.of(fold, {
 * strategies })`): typed against segmented state, they never split a segment.
 *
 * - `elide({ keepNewest, where?, map })` transforms the data of old segments (e.g. truncates old
 *   tool outputs) and never removes one;
 * - `dropOldest({ keepFrom? })` drops whole segments, oldest first, never those from `keepFrom` on,
 *   until the tokens fit;
 * - `fromNewest(fold, kind)` and `newest(count?)` are `keepFrom`s: from the newest segment of that
 *   kind on, or the newest `count` segments (default 1).
 *
 * ```ts
 * const ChatView = ContextView.of(Conversation, {
 *   strategies: [
 *     ContextStrategy.elide({ keepNewest: 6, map: truncateToolOutputs }),
 *     ContextStrategy.dropOldest({ keepFrom: ContextStrategy.fromNewest(Conversation, 'user') }),
 *   ],
 * });
 * ```
 *
 * A strategy is any pure `ContextStrategy<State>` function, so you can add your own to the list.
 */
export const ContextStrategy: {
  /**
   * Transforms the data of the segments older than the newest `keepNewest` (those matching
   * `where`) with `map`, e.g. to truncate old tool outputs. Never removes a segment, and does not
   * check the budget itself: the view runs it only while over budget, and the next strategy only
   * if still over. An old segment elides to the same object on every read (memoized per segment),
   * so `map` runs once per segment and the view counts its elided form once. Throws a
   * `RangeError` when `keepNewest` is not a non-negative integer.
   */
  readonly elide: <T>(options: ElideOptions<T>) => SegmentContextStrategy<T>;
  /**
   * Drops whole segments, oldest first, until the tokens fit the budget, but none from
   * `keepFrom(segments)` on (called once per read). When only those are left the state stays
   * over budget (the view reports `overBudget`). The summary is never dropped; its tokens count
   * toward the total. Throws a `TypeError` for a `keepFrom` that is not a function, and a
   * `RangeError` when it returns anything but an integer from 0 to `segments.length`.
   */
  readonly dropOldest: <T>(options?: DropOldestOptions<T>) => SegmentContextStrategy<T>;
  /**
   * A `keepFrom` for `dropOldest` (or a view's `split`): the index of the newest segment of
   * `kind`, read from the field the fold's `tag` names, e.g. `fromNewest(Conversation, 'user')`
   * keeps the current turn. Without a segment of that kind it returns 0: every segment is newer
   * than the newest one of that kind (e.g. a compaction summarized it away), so all of them stay.
   * `kind` is typed by the fold's data and tag; throws a `TypeError` for anything but a
   * `SegmentedFold` and a string kind.
   */
  readonly fromNewest: <Data, Tag extends string>(
    fold: AnySegmentedFold<Data, Tag>,
    kind: SegmentKindOf<Data, Tag>,
  ) => KeepFrom<Data>;
  /**
   * A `keepFrom` for `dropOldest` or a view's `split`: the newest `count` segments (default 1)
   * stay, whatever their size, e.g. `split(state, { keepTokens, keepFrom: newest() })` always
   * keeps the step the model is working on. Throws a `RangeError` when `count` is not a
   * non-negative integer.
   */
  readonly newest: <T>(count?: number) => KeepFrom<T>;
} = Object.freeze({ elide, dropOldest, fromNewest, newest });
