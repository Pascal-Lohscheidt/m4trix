import {
  type AnyContextFold,
  ContextFold,
  ContextFoldDefinitionError,
  type FoldReadStateOf,
} from './context-fold.js';
import {
  type AnySegmentedFold,
  type AnySegmentedState,
  isSegmentedFold,
  type Segment,
  type SegmentedState,
} from './segmented-fold.js';
import {
  type ContextStrategy,
  type ContextStrategyBudget,
  type KeepFrom,
  keepFromIndex,
} from './strategies.js';

/**
 * Views: a budget-aware reading of a fold's state. `ContextView.of(fold, options)` returns a pure
 * function `view(state, { budget })`: it counts the state's tokens and runs the view's strategies
 * over it until it fits the budget. A view is not read through `ctx.folds`: read the fold
 * (`await folds.conversation()`) and pass its state, with the budget of this read.
 */

/**
 * Rough token count of a value: ⌈length of its JSON / 4⌉ (0 for `undefined`). A heuristic (about
 * four characters per token for English text and code with common tokenizers), cheap and
 * dependency-free; inject a real tokenizer through a view's `count` when precision matters.
 */
export function approxTokenCount(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Math.ceil(json.length / 4);
}

/** Options of one read of a view: `view(state, { budget })`. */
export type ViewReadOptions = {
  /**
   * Token budget of this read: a positive number (fractions are fine, e.g. `window * 0.8`), or
   * `Infinity` for none.
   */
  readonly budget: number;
};

/** What reading a view yields. */
export interface ViewResult<State> {
  /** The state after the strategies that ran (the state given itself when none ran). */
  readonly state: State;
  /** Tokens of `state`: for a segmented state, its summary plus every segment. */
  readonly tokens: number;
  /** The budget of the read (`Infinity`: no budget). */
  readonly budget: number;
  /** `tokens > budget`: the strategies could not trim enough (e.g. nothing more may be dropped). */
  readonly overBudget: boolean;
  /** Ids of the segments the strategies removed, oldest first; always empty without segments. */
  readonly dropped: ReadonlyArray<string>;
  /**
   * Nothing was dropped and the state is within budget: the view holds the whole conversation
   * (strategies may have elided parts of it). `false` is the moment to compact, when compacting
   * can help (see `SegmentedContextView#split`). Without segments nothing is ever reported
   * dropped, so it is `!overBudget`.
   */
  readonly fits: boolean;
}

/** Options of `SegmentedContextView#split`. */
export type ViewSplitOptions<T> = {
  /**
   * Tokens the newest segments may take: a non-negative number, or `Infinity` (keep them all).
   * Counted with the view's counter; the summary does not count.
   */
  readonly keepTokens: number;
  /**
   * The segments from this index on are kept whatever their tokens, e.g. the newest one
   * (`ContextStrategy.newest()`); older ones are kept as long as they fit next to them. Called
   * once, with the segments of the state given.
   */
  readonly keepFrom?: KeepFrom<T>;
};

/** A compaction's cut of a segmented state (`SegmentedContextView#split`), oldest first. */
export type ViewSplit<S> = {
  /** The segments before `kept`: what a compaction summarizes (with the earlier summary). */
  readonly older: ReadonlyArray<S>;
  /** The newest whole segments that fit `keepTokens` (and those from `keepFrom` on). */
  readonly kept: ReadonlyArray<S>;
};

/**
 * A view of a fold without segments: `view(state, { budget })` reads `state` (as `ctx.folds`
 * returns it; never written to) at that budget, counting its tokens with `measure` and running
 * the view's strategies while they exceed it.
 */
export interface ContextView<State> {
  /**
   * Reads `state` at `options.budget`. Throws a `RangeError` for a budget that is not a positive
   * number or `Infinity`.
   */
  (state: State, options: ViewReadOptions): ViewResult<State>;
  /** The fold the view reads; the view function is named after it (`conversationView`). */
  readonly fold: AnyContextFold;
}

/**
 * A view of a `SegmentedFold` with segment data `Data` and summary `Summary`:
 * `view(state, { budget })` reads `state` (as `ctx.folds` returns it; never written to) at that
 * budget, counting its segments and summary and running the view's strategies while they
 * exceed it. `count` and `split` need no budget: they count and cut a state for a compaction.
 */
export interface SegmentedContextView<Data, Summary = never> {
  /**
   * Reads `state` at `options.budget`. Throws a `RangeError` for a budget that is not a positive
   * number or `Infinity`.
   */
  (
    state: SegmentedState<Data, Summary>,
    options: ViewReadOptions,
  ): ViewResult<SegmentedState<Data, Summary>>;
  /** The fold the view reads; the view function is named after it (`conversationView`). */
  readonly fold: AnySegmentedFold<Data, string, Summary>;
  /**
   * Tokens of one segment, with the view's counter: cached per segment object and shared with the
   * view's reads, so a segment is counted once.
   */
  count(segment: Segment<Data>): number;
  /**
   * Cuts `state` (typically the fold's whole state, as read) for a compaction that targets a
   * size: `kept` are the newest whole segments whose tokens fit `keepTokens`, `older` the rest.
   * Runs no strategy and needs no budget. Never splits a segment, and `kept` is always the newest
   * ones in order: it stops at the first segment that does not fit. `older` empty means
   * compacting would only summarize the summary again. Throws a `RangeError` for a
   * `keepTokens` that is not a non-negative number or `Infinity`, or a `keepFrom` index out of
   * range.
   *
   * ```ts
   * const { older, kept } = ChatView.split(conversation, {
   *   keepTokens: budget / 2,
   *   keepFrom: ContextStrategy.newest(),
   * });
   * // summary = summarize(conversation.summary, older); segments = kept
   * ```
   */
  split(
    state: SegmentedState<Data, Summary>,
    options: ViewSplitOptions<Data>,
  ): ViewSplit<Segment<Data>>;
}

/** Options of a view of a `SegmentedFold`: tokens are counted per segment. */
export type SegmentedViewOptions<Data, Summary = never> = {
  /**
   * Tokens of one segment (default `approxTokenCount(segment)`). Must be pure: the view caches the
   * count of each segment (segments are immutable), so it counts a segment once.
   */
  readonly count?: (segment: Segment<Data>) => number;
  /** Tokens of the summary, when there is one (default `approxTokenCount(summary)`). */
  readonly countSummary?: (summary: Summary) => number;
  /**
   * Run in order, each at most once, and only while the state is over budget (none run when it
   * already fits). The tokens are counted again after each one. Default: none (the view only
   * measures, e.g. to decide when to compact).
   */
  readonly strategies?: ReadonlyArray<ContextStrategy<SegmentedState<Data, Summary>>>;
};

/** Options of a view of a fold without segments (a `ContextFold`): the whole state is counted. */
export type StateViewOptions<State> = {
  /** Tokens of the whole state, e.g. `(state) => approxTokenCount(state)`. */
  readonly measure: (state: State) => number;
  /** As for segmented views; strategies get `measure` as their `count`. */
  readonly strategies?: ReadonlyArray<
    (state: State, context: ContextStrategyBudget<State>) => State
  >;
};

/**
 * Type-level marker: `ContextView.of(fold)` without options, for a fold without segments, which
 * needs `{ measure(state) }`. Its key is the message of the type error.
 */
export interface ViewNeedsMeasure {
  /** Shown in the type error. */
  readonly 'ContextView.of(fold, { measure }): a fold without segments is counted by measure(state)': true;
}

/** Options as the runtime sees them (validated by `ContextView.of`). */
type RuntimeViewOptions = {
  readonly count?: unknown;
  readonly countSummary?: unknown;
  readonly measure?: unknown;
  readonly strategies?: unknown;
};

type AnyStrategy = (
  state: unknown,
  context: { budget: number; tokens: number; count: (unit: never) => number },
) => unknown;

/** Ids of `before`'s segments missing from `after`, by occurrence (ids may repeat). */
function droppedIds(before: AnySegmentedState, after: AnySegmentedState): string[] {
  const kept = new Map<string, number>();
  for (const { id } of after.segments) kept.set(id, (kept.get(id) ?? 0) + 1);
  const dropped: string[] = [];
  for (const { id } of before.segments) {
    const left = kept.get(id) ?? 0;
    if (left > 0) kept.set(id, left - 1);
    else dropped.push(id);
  }
  return dropped;
}

/** `ContextView.of` (documented there). */
function of(fold: AnyContextFold, options?: RuntimeViewOptions): ContextView<unknown> {
  ContextFold.validate(fold);
  const label = `ContextView of fold ${JSON.stringify(fold.name)}`;
  const fail = (detail: string): never => {
    throw new ContextFoldDefinitionError(fold.name, `${label}: ${detail}`);
  };
  const { strategies = [], count, countSummary, measure } = options ?? {};
  if (!Array.isArray(strategies) || strategies.some((strategy) => typeof strategy !== 'function')) {
    fail('strategies must be an array of functions (state, { budget, tokens, count }) => state.');
  }
  if ([count, countSummary, measure].some((fn) => fn !== undefined && typeof fn !== 'function')) {
    fail('count, countSummary and measure must be functions.');
  }
  const segmented = isSegmentedFold(fold);
  if (segmented && measure !== undefined) {
    fail(
      'a SegmentedFold is counted per segment; pass count(segment) (and countSummary), not ' +
        'measure.',
    );
  }
  if (!segmented && (count !== undefined || countSummary !== undefined)) {
    fail(
      'count and countSummary count segments of a SegmentedFold; a fold without segments ' +
        'takes measure(state).',
    );
  }
  if (!segmented && measure === undefined) {
    fail(
      'the fold has no segments; pass measure(state) to count its tokens, or build the fold ' +
        'with SegmentedFold.',
    );
  }

  /** Tokens of one segment, counted once per segment object. */
  const countSegment = (count ?? approxTokenCount) as (segment: Segment<unknown>) => number;
  const counts = new WeakMap<Segment<unknown>, number>();
  const cachedCount = (segment: Segment<unknown>): number => {
    let tokens = counts.get(segment);
    if (tokens === undefined) {
      tokens = countSegment(segment);
      counts.set(segment, tokens);
    }
    return tokens;
  };
  const tokensOfSummary = (countSummary ?? approxTokenCount) as (value: unknown) => number;
  /** Tokens of a whole state; strategies get `unit`, per segment or the whole state. */
  const tokensOf = segmented
    ? (state: unknown): number => {
        const { summary, segments } = state as AnySegmentedState;
        let tokens = summary === undefined ? 0 : tokensOfSummary(summary);
        for (const segment of segments) tokens += cachedCount(segment);
        return tokens;
      }
    : (measure as (state: unknown) => number);
  const unit = (segmented ? cachedCount : measure) as (unit: never) => number;

  const view = (state: unknown, read: ViewReadOptions | undefined): ViewResult<unknown> => {
    const budget = read?.budget as number;
    // Any positive number (fractions included, e.g. a share of a window), or Infinity.
    if (!(typeof budget === 'number' && budget > 0)) {
      throw new RangeError(
        `${label}: the budget must be a positive number of tokens, or Infinity (no budget); ` +
          `got ${budget}.`,
      );
    }
    let current = state;
    let tokens = tokensOf(current);
    for (const strategy of strategies as ReadonlyArray<AnyStrategy>) {
      if (tokens <= budget) break;
      current = strategy(current, { budget, tokens, count: unit });
      tokens = tokensOf(current);
    }
    const overBudget = tokens > budget;
    const dropped = segmented
      ? droppedIds(state as AnySegmentedState, current as AnySegmentedState)
      : [];
    return {
      state: current,
      tokens,
      budget,
      overBudget,
      dropped,
      fits: !overBudget && dropped.length === 0,
    };
  };

  const split = (
    state: AnySegmentedState,
    splitOptions: ViewSplitOptions<unknown> | undefined,
  ): ViewSplit<Segment<unknown>> => {
    const keepTokens = splitOptions?.keepTokens as number;
    if (!(typeof keepTokens === 'number' && keepTokens >= 0)) {
      throw new RangeError(
        `${label}: split() needs keepTokens, a non-negative number of tokens or Infinity; got ` +
          `${keepTokens}.`,
      );
    }
    const { keepFrom } = splitOptions as ViewSplitOptions<unknown>;
    const { segments } = state;
    let cut = keepFrom ? keepFromIndex(`${label}: split()`, keepFrom, segments) : segments.length;
    let kept = 0;
    for (let index = cut; index < segments.length; index++) {
      kept += cachedCount(segments[index] as Segment<unknown>);
    }
    while (cut > 0) {
      const tokens = cachedCount(segments[cut - 1] as Segment<unknown>);
      if (kept + tokens > keepTokens) break;
      kept += tokens;
      cut--;
    }
    return { older: segments.slice(0, cut), kept: segments.slice(cut) };
  };

  // Named after the fold (in stack traces and errors), and pointing back to it.
  Object.defineProperty(view, 'name', { value: `${fold.name}View` });
  const members = segmented ? { fold, count: cachedCount, split } : { fold };
  return Object.freeze(Object.assign(view, members)) as ContextView<unknown>;
}

/**
 * The type of `ContextView`: `of` builds a view of a `SegmentedFold` (told apart by its builder,
 * not by the shape of its state) or of any other fold.
 */
export interface ContextViewBuilder {
  /**
   * A view of a `SegmentedFold`, counted per segment: `count` (default `approxTokenCount`) plus
   * the summary (`countSummary`), with segment strategies (`ContextStrategy`); it can also
   * `count` and `split` segments for a compaction. The options are optional. The view reads the
   * fold's state as `ctx.folds` returns it (`FoldReadStateOf`) and never writes to it.
   *
   * Throws `ContextFoldDefinitionError` for something that is not a fold, a fold without events,
   * and invalid options; a read throws a `RangeError` for a budget that is not a positive number
   * or `Infinity`.
   */
  of<Data, Summary>(
    fold: AnySegmentedFold<Data, string, Summary>,
    options?: SegmentedViewOptions<Data, Summary>,
  ): SegmentedContextView<Data, Summary>;
  /**
   * A view of any other fold (a `ContextFold`, whatever the shape of its state): `measure(state)`
   * counts the whole state, and strategies are of its read state type (`FoldReadStateOf`; type
   * helpers with it, not with a mutable state type). Throws like the segmented overload.
   */
  of<F extends AnyContextFold>(
    fold: F & ([F] extends [AnySegmentedFold] ? never : unknown),
    options: StateViewOptions<FoldReadStateOf<F>>,
  ): ContextView<FoldReadStateOf<F>>;
  /**
   * No options for a fold without segments: a type error (`ViewNeedsMeasure`), since it needs
   * `{ measure(state) }`; it throws `ContextFoldDefinitionError` at runtime.
   */
  of(fold: AnyContextFold & ViewNeedsMeasure): never;
}

/**
 * Builds views: `ContextView.of(fold, options)` returns a pure function `view(state, { budget })`
 * that counts the state's tokens and, while they exceed the budget, runs `strategies` over it, in
 * order, each at most once. The budget is given per read, so one view serves any budget.
 *
 * ```ts
 * const ChatView = ContextView.of(Conversation, {
 *   strategies: [
 *     ContextStrategy.elide({ keepNewest: 6, map: truncateToolOutputs }),
 *     ContextStrategy.dropOldest({ keepFrom: ContextStrategy.fromNewest(Conversation, 'user') }),
 *   ],
 * });
 *
 * // In an agent with .folds([Conversation]):
 * const conversation = await folds.conversation();
 * const chat = ChatView(conversation, { budget: 50_000 });
 * if (!chat.fits) { ... } // compact: ChatView.split(conversation, { keepTokens: 25_000 })
 * ```
 */
export const ContextView: ContextViewBuilder = Object.freeze({
  of,
}) as unknown as ContextViewBuilder;
