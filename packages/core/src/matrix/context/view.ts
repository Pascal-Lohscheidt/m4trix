import type { AnyContextFold } from './context-fold.js';
import type { AnySegmentedState, CheckpointOf, Segment, SegmentOf } from './segmented-fold.js';
import type { ContextStrategy } from './strategies.js';

/**
 * Views: a budget-aware reading of a fold (`fold.view(name, options)`). A view is a `FoldSource`
 * of its own: `ctx.folds[name]()` folds the base fold (cached as usual) and runs the view's
 * strategies over the state until its tokens fit the budget.
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

/** What reading a view yields. */
export type ViewResult<State> = {
  /** The state after the strategies that ran (the fold's state itself when none ran). */
  readonly state: State;
  /** Tokens of `state`: for a segmented state, its checkpoint plus every segment. */
  readonly tokens: number;
  /** The view's budget (`Infinity`: no budget). */
  readonly budget: number;
  /** `tokens > budget`: the strategies could not trim enough (e.g. every segment pinned). */
  readonly overBudget: boolean;
  /** Ids of the segments the strategies removed, oldest first; always empty without segments. */
  readonly dropped: ReadonlyArray<string>;
};

/**
 * A named, budgeted view of a fold: a `FoldSource` (`.folds([view])` → `folds[name]()`) whose
 * result is a `ViewResult`. The runtime caches the base fold's state, not the view's result, so
 * views of one fold share the folding work.
 */
export interface ContextView<Name extends string, State> {
  /** Accessor name in `ctx.folds` (a JS identifier). */
  readonly name: Name;
  /** The fold whose state the view reads. */
  readonly fold: AnyContextFold;
  /** Token budget (`Infinity`: no budget, the strategies never run). */
  readonly budget: number;
  /** Runs the strategies over `state` while it is over budget (pure). */
  select(state: State): ViewResult<State>;
}

/** Options of a view of a segmented fold. */
export type SegmentedViewOptions<State extends AnySegmentedState> = {
  /** Token budget: a positive integer, or `Infinity` for none. */
  readonly budget: number;
  /**
   * Tokens of one segment (default `approxTokenCount(segment)`). Must be pure: the view caches the
   * count of each segment (segments are immutable), so it counts a segment once.
   */
  readonly count?: (segment: SegmentOf<State>) => number;
  /** Tokens of the checkpoint, when there is one (default `approxTokenCount(checkpoint)`). */
  readonly countCheckpoint?: (checkpoint: CheckpointOf<State>) => number;
  /**
   * Run in order, each at most once, and only while the state is over budget (none run when it
   * already fits). The tokens are counted again after each one. Default: none (the view only
   * measures, e.g. to decide when to compact).
   */
  readonly strategies?: ReadonlyArray<ContextStrategy<State>>;
};

/** Options of a view of a fold whose state has no segments. */
export type StateViewOptions<State> = {
  /** Token budget: a positive integer, or `Infinity` for none. */
  readonly budget: number;
  /** Tokens of the whole state, e.g. `(state) => approxTokenCount(state)`. */
  readonly measure: (state: State) => number;
  /** As for segmented views; strategies get `measure` as their `count`. */
  readonly strategies?: ReadonlyArray<ContextStrategy<State>>;
};

/** View options for a fold state: per-segment counting for segmented states, else `measure`. */
export type ViewOptions<State> = [State] extends [AnySegmentedState]
  ? SegmentedViewOptions<State>
  : StateViewOptions<State>;

/** Options as the runtime sees them (validated by `ContextFold#view`). */
export type RuntimeViewOptions = {
  readonly budget: number;
  readonly count?: (segment: Segment<unknown>) => number;
  readonly countCheckpoint?: (checkpoint: unknown) => number;
  readonly measure?: (state: unknown) => number;
  readonly strategies?: ReadonlyArray<(state: unknown, context: never) => unknown>;
};

type AnyStrategy = (
  state: unknown,
  context: { budget: number; tokens: number; count: (unit: never) => number },
) => unknown;

/** A segmented state at runtime: an object with a `segments` array. */
export function isSegmentedState(value: unknown): value is AnySegmentedState {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { segments?: unknown }).segments)
  );
}

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

/** Runtime of `ContextView` (options validated by `ContextFold#view`). */
class ContextViewImpl {
  readonly budget: number;
  private readonly strategies: ReadonlyArray<AnyStrategy>;
  /** Tokens of a whole state. */
  private readonly measure: (state: unknown) => number;
  /** What strategies get as `count`: per segment (cached) or the whole-state `measure`. */
  private readonly count: (unit: never) => number;
  private readonly segmented: boolean;

  constructor(
    readonly fold: AnyContextFold,
    readonly name: string,
    options: RuntimeViewOptions,
  ) {
    this.budget = options.budget;
    this.strategies = (options.strategies ?? []) as ReadonlyArray<AnyStrategy>;
    const { measure } = options;
    this.segmented = measure === undefined;
    if (measure) {
      this.measure = measure;
      this.count = measure;
      return;
    }
    const countSegment = options.count ?? approxTokenCount;
    const countCheckpoint = options.countCheckpoint ?? approxTokenCount;
    const counts = new WeakMap<Segment<unknown>, number>();
    const count = (segment: Segment<unknown>): number => {
      let tokens = counts.get(segment);
      if (tokens === undefined) {
        tokens = countSegment(segment);
        counts.set(segment, tokens);
      }
      return tokens;
    };
    this.count = count;
    this.measure = (state) => {
      const { checkpoint, segments } = state as AnySegmentedState;
      let tokens = checkpoint === undefined ? 0 : countCheckpoint(checkpoint);
      for (const segment of segments) tokens += count(segment);
      return tokens;
    };
  }

  select(state: unknown): ViewResult<unknown> {
    const { budget, count } = this;
    let current = state;
    let tokens = this.measure(current);
    for (const strategy of this.strategies) {
      if (tokens <= budget) break;
      current = strategy(current, { budget, tokens, count });
      tokens = this.measure(current);
    }
    return {
      state: current,
      tokens,
      budget,
      overBudget: tokens > budget,
      dropped: this.segmented
        ? droppedIds(state as AnySegmentedState, current as AnySegmentedState)
        : [],
    };
  }
}

/** Creates a view of `fold` (options already validated). */
export function createView(
  fold: AnyContextFold,
  name: string,
  options: RuntimeViewOptions,
): ContextViewImpl {
  return new ContextViewImpl(fold, name, options);
}
