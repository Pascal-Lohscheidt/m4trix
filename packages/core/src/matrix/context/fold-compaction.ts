import type { AnyContextFold, FoldReadStateOf, FoldStateOf } from './context-fold.js';
import {
  assertCompactable,
  type FoldCheckpointEventName,
  FoldCompactionError,
} from './fold-checkpoint.js';
import type { CompactingFoldReader } from './fold-reader.js';
import {
  type AnySegmentedFold,
  type AnySegmentedState,
  isSegmentedFold,
  type Segment,
  type SegmentedState,
} from './segmented-fold.js';
import type { KeepFrom } from './strategies.js';
import type { SegmentedContextView } from './view.js';

/**
 * Compaction: `folds.<name>.compact(next)` replaces a fold's state with `next(state)` for good.
 * The runtime publishes it as the fold's checkpoint (see `FoldCheckpointPayload`), so every later
 * read, warm or cold, starts from it.
 */

/**
 * Type-level marker in place of `compact` for a fold that cannot compact: one without a `state`
 * schema, or a run-scoped one. It has no call signature, so calling it is a type error that names
 * the fold.
 */
export interface FoldCannotCompact<Name extends string> {
  /** The fold, shown in the type error. */
  readonly 'compact needs a context-scoped fold with a state schema (ContextFold.of(name, { state }) or a SegmentedFold); fold': Name;
}

/**
 * `compact(next)`: reads the fold, calls `next` with the state read (read-only) and publishes the
 * state it returns as the fold's checkpoint. Resolves to the fold's state afterwards, as every
 * read returns it from then on: the new state plus the events published since the read `next`
 * got (none are lost while `next` runs, e.g. during a model call).
 *
 * Rejects with `FoldCompactionError` (`'invalid-state'`: the new state does not encode with the
 * fold's `state` schema, unknown fields included; `'unsupported'`: outside a network), with
 * `next`'s own error when it throws (nothing is published then), and with `AgentAbortedError`
 * when the run ended before the checkpoint was stored.
 */
export type FoldCompactFn<State, ReadState = State> = (
  next: (state: ReadState) => State | Promise<State>,
) => Promise<ReadState>;

/** What the summary of a segmented compaction is written from (`SegmentedCompactOptions`). */
export type SegmentedCompactInput<Data, Summary> = {
  /** The summary an earlier compaction wrote, if any: carry it over, it covers older turns. */
  readonly summary: Summary | undefined;
  /** The segments to summarize, oldest first: everything before `kept`. */
  readonly older: ReadonlyArray<Segment<Data>>;
  /** The newest segments, kept as they are after the summary (context; not to summarize). */
  readonly kept: ReadonlyArray<Segment<Data>>;
};

/** Options of a segmented fold's `compact({ ... })`: when to compact, what to keep, the summary. */
export type SegmentedCompactOptions<Data, Summary> = {
  /** The view the state is read with (`ContextView.of(fold)`): it decides whether it `fits`. */
  readonly view: SegmentedContextView<Data, Summary>;
  /** Token budget of the view: a compaction only happens when the view does not fit it. */
  readonly budget: number;
  /** Tokens the newest segments kept as they are may take (see `SegmentedContextView#split`). */
  readonly keepTokens: number;
  /** The segments from this index on are kept whatever their size (e.g. `ContextStrategy.newest()`). */
  readonly keepFrom?: KeepFrom<Data>;
  /**
   * Writes the new summary of `summary` (the earlier one) and `older`, e.g. with a model call
   * through a layer of the agent. The new state is `{ summary, segments: kept }`.
   */
  readonly summarize: (input: SegmentedCompactInput<Data, Summary>) => Summary | Promise<Summary>;
};

/** What a segmented fold's `compact({ ... })` resolves to. */
export type SegmentedCompaction<State> = {
  /** A checkpoint was published: the view did not fit and some segments were summarized. */
  readonly compacted: boolean;
  /** The fold's state: after the compaction when there was one, else as read. */
  readonly state: State;
  /** How many segments the new summary replaced (0 without a compaction). */
  readonly summarized: number;
};

/**
 * `compact` of a segmented fold with segment data `Data` and summary `Summary`: `compact(next)`
 * (see `FoldCompactFn`), or the policy `compact({ view, budget, keepTokens, keepFrom?, summarize
 * })`. The policy reads the fold and compacts only when it helps: when `view(state, { budget })`
 * does not `fit` and `view.split(state, { keepTokens, keepFrom })` leaves `older` segments. Then
 * the new state is `{ summary: await summarize({ summary, older, kept }), segments: kept }`, cut
 * from the very state the checkpoint's `through` belongs to. Rejects like `compact(next)`, with a
 * `TypeError` for options that do not fit the fold and a `RangeError` for a budget or
 * `keepTokens` the view rejects.
 */
export interface SegmentedFoldCompact<Data, Summary> {
  /** Publishes `next(state)` as the new state (see `FoldCompactFn`). */
  (
    next: (
      state: SegmentedState<Data, Summary>,
    ) => SegmentedState<Data, Summary> | Promise<SegmentedState<Data, Summary>>,
  ): Promise<SegmentedState<Data, Summary>>;
  /** Compacts when the view does not fit and some segments are older than what it keeps. */
  (
    options: SegmentedCompactOptions<Data, Summary>,
  ): Promise<SegmentedCompaction<SegmentedState<Data, Summary>>>;
}

/**
 * `folds.<name>.compact` of the fold `F`: `SegmentedFoldCompact` for a segmented fold with a
 * `summary` schema, `FoldCompactFn` for any other fold that can compact, `FoldCannotCompact` for
 * a fold without a `state` schema or a run-scoped one.
 */
export type FoldCompact<F extends AnyContextFold> = F extends {
  readonly checkpointEventName: FoldCheckpointEventName;
}
  ? F extends AnySegmentedFold<infer Data, string, infer Summary>
    ? [Summary] extends [never]
      ? FoldCompactFn<FoldStateOf<F>, FoldReadStateOf<F>>
      : SegmentedFoldCompact<Data, Summary>
    : FoldCompactFn<FoldStateOf<F>, FoldReadStateOf<F>>
  : FoldCannotCompact<F['name']>;

/**
 * One accessor of `ctx.folds`: call it to read the fold (`await folds.conversation()`), or
 * `compact` it (see `FoldCompact`).
 */
export interface FoldAccessor<F extends AnyContextFold> {
  /** Reads the fold: its state, read-only (`FoldReadStateOf`). */
  (): Promise<FoldReadStateOf<F>>;
  /** Replaces the fold's state for good, as its checkpoint (see `FoldCompact`). */
  readonly compact: FoldCompact<F>;
}

/** Segmented compact options as the runtime sees them (validated by `segmentedPolicy`). */
type RuntimeCompactOptions = {
  readonly view: SegmentedContextView<unknown, unknown>;
  readonly budget: number;
  readonly keepTokens: number;
  readonly keepFrom?: KeepFrom<unknown>;
  readonly summarize: (input: SegmentedCompactInput<unknown, unknown>) => unknown;
};

type CompactNext = Parameters<NonNullable<CompactingFoldReader['compact']>>[1];

/**
 * The `next` of a segmented fold's policy (`SegmentedFoldCompact`): compacts only when the view
 * does not fit and the split leaves older segments. Calls `onSummarized` with how many it
 * summarized. Throws a `TypeError` for options that do not fit `fold`.
 */
function segmentedPolicy(
  fold: AnyContextFold,
  options: RuntimeCompactOptions | undefined,
  onSummarized: (count: number) => void,
): CompactNext {
  const prefix = `folds.${fold.name}.compact(options)`;
  if (!isSegmentedFold(fold)) {
    throw new TypeError(
      `${prefix}: the options form is for a SegmentedFold; pass a function (state) => newState.`,
    );
  }
  const { view, budget, keepTokens, keepFrom, summarize } =
    options ?? ({} as RuntimeCompactOptions);
  if (typeof view !== 'function' || view.fold !== fold || typeof summarize !== 'function') {
    throw new TypeError(
      `${prefix}: view must be a view of this fold (ContextView.of(${fold.name})); summarize ` +
        'must be a function.',
    );
  }
  return async (read) => {
    const state = read as AnySegmentedState;
    // Both first: they validate the budget and keepTokens on every call, compacting or not.
    const { fits } = view(state, { budget });
    const { older, kept } = view.split(state, { keepTokens, keepFrom });
    if (fits || older.length === 0) return undefined;
    const summary = await summarize({ summary: state.summary, older, kept });
    onSummarized(older.length);
    return { state: { summary, segments: kept } };
  };
}

/**
 * @internal `folds.<name>.compact` of `fold`, through `reader`: `compact(next)`, or a segmented
 * fold's `compact(options)` policy.
 */
export function compactor(
  fold: AnyContextFold,
  reader: CompactingFoldReader,
): (next: unknown) => Promise<unknown> {
  return async (next) => {
    let summarized = 0;
    const policy =
      typeof next === 'function'
        ? undefined
        : segmentedPolicy(fold, next as RuntimeCompactOptions | undefined, (count) => {
            summarized = count;
          });
    if (!reader.compact) {
      assertCompactable(fold);
      throw new FoldCompactionError(
        fold.name,
        'unsupported',
        `folds.${fold.name}.compact(): compaction needs a network: the checkpoint is published ` +
          'to its store.',
      );
    }
    if (policy) return { ...(await reader.compact(fold, policy)), summarized };
    const run = next as (state: unknown) => unknown;
    const { state } = await reader.compact(fold, async (read) => ({ state: await run(read) }));
    return state;
  };
}
