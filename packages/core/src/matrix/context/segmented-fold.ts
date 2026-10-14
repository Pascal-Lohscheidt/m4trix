import type { AgentNetworkEventDef, S } from '../agent-network/agent-network-event.js';
import {
  ContextFold,
  type ContextFoldOptions,
  type FoldScope,
  type ValidFoldName,
} from './context-fold.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/**
 * Segmented folds: the state is a list of **segments**, each an atomic unit of the conversation
 * (a user prompt, a model step together with all its tool results, a final answer), plus an
 * optional checkpoint (e.g. the summary a compaction left behind). Views trim a segmented state
 * to a token budget segment by segment, so a model step is never separated from its results.
 */

/**
 * One atomic unit of a segmented state. `id` addresses it (`SegmentedFold.attach`, a view's
 * `dropped`, `pin` predicates); `data` is what the handlers fold into it. Ids should be unique
 * (a payload id such as a step id, or one derived from the event, e.g. `prompt:${runId}`).
 */
export type Segment<T> = {
  readonly id: string;
  readonly data: T;
};

/**
 * State of a segmented fold: its segments, oldest first, and the checkpoint the newest checkpoint
 * event restored (absent before the first one, and for folds without a checkpoint type `C`).
 */
export type SegmentedState<T, C = never> = {
  readonly checkpoint?: C;
  readonly segments: ReadonlyArray<Segment<T>>;
};

/** Any segmented state: the constraint of the segment helpers and segment strategies. */
export type AnySegmentedState = SegmentedState<unknown, unknown>;

/** The segment type of a segmented state. */
export type SegmentOf<State extends AnySegmentedState> = State['segments'][number];

/** The segment data type of a segmented state. */
export type SegmentDataOf<State extends AnySegmentedState> = SegmentOf<State>['data'];

/** The checkpoint type of a segmented state (`never` for a fold without one). */
export type CheckpointOf<State extends AnySegmentedState> = Exclude<State['checkpoint'], undefined>;

/** `SegmentedFold.of(name, options)`: choose the scope, then the folded events. */
export interface SegmentedFoldBuilder<Name extends string, Scope extends FoldScope = 'context'> {
  /** Folds every run of the context (`'context'`, the default) or the current run (`'run'`). */
  scope<const NextScope extends FoldScope>(scope: NextScope): SegmentedFoldBuilder<Name, NextScope>;
  /** The events the fold reads, as in `ContextFold.of(…).over(…)`. */
  over<const E extends EventDef>(
    events: ReadonlyArray<E>,
  ): SegmentedFoldEventsBuilder<Name, Scope, E>;
}

/** After `over()`: the scope can still change; `segments<T, C>()` makes it a fold. */
export interface SegmentedFoldEventsBuilder<
  Name extends string,
  Scope extends FoldScope,
  Over extends EventDef,
> {
  /** Folds every run of the context (`'context'`, the default) or the current run (`'run'`). */
  scope<const NextScope extends FoldScope>(
    scope: NextScope,
  ): SegmentedFoldEventsBuilder<Name, NextScope, Over>;
  /**
   * Fixes the state to `SegmentedState<T, C>` (segment data `T`, checkpoint `C`), starting with
   * no segments: the `initial()` of a segmented fold. The result is a plain `ContextFold`; add
   * its handlers with `.on()` (using `SegmentedFold.open` / `attach`) and `.checkpointOn()`.
   */
  segments<T, C = never>(): ContextFold<Name, Scope, Over, SegmentedState<T, C>>;
}

/** The part of the `ContextFold` builder the segmented builder drives. */
type FoldBuilder = {
  readonly name: string;
  scope(scope: FoldScope): FoldBuilder;
  over(events: ReadonlyArray<EventDef>): FoldBuilder;
  initial(initial: () => AnySegmentedState): unknown;
};

const emptySegmentedState = (): AnySegmentedState => ({ segments: [] });

/** Runtime of both segmented builder stages: a `ContextFold` builder with a fixed `initial()`. */
class SegmentedFoldBuilderImpl {
  readonly name: string;

  constructor(private readonly builder: FoldBuilder) {
    this.name = builder.name;
  }

  scope(scope: FoldScope): SegmentedFoldBuilderImpl {
    return new SegmentedFoldBuilderImpl(this.builder.scope(scope));
  }

  over(events: ReadonlyArray<EventDef>): SegmentedFoldBuilderImpl {
    return new SegmentedFoldBuilderImpl(this.builder.over(events));
  }

  segments(): unknown {
    return this.builder.initial(emptySegmentedState);
  }
}

/**
 * Defines a segmented fold and updates segmented states. `open` and `attach` are pure (they
 * return a new state and never mutate the given one), so handlers built from them stay pure.
 *
 * ```ts
 * const Conversation = SegmentedFold.of('conversation', { version: 1 })
 *   .over([UserPrompt, ModelStep, ToolResult, ContextCompacted])
 *   .segments<Entry, string>() // segment data, checkpoint (summary)
 *   .on(UserPrompt, (state, { meta, payload }) =>
 *     SegmentedFold.open(state, `prompt:${meta.runId}`, { kind: 'user', text: payload.text }))
 *   .on(ModelStep, (state, { payload: { stepId, text, toolCalls } }) =>
 *     SegmentedFold.open(state, stepId, { kind: 'step', text, toolCalls, results: [] }))
 *   .on(ToolResult, (state, { payload }) =>
 *     SegmentedFold.attach(state, payload.stepId, (step) => withResult(step, payload)))
 *   .checkpointOn(ContextCompacted, ({ payload }) => ({
 *     checkpoint: payload.summary,
 *     segments: payload.kept,
 *   }));
 * ```
 */
export const SegmentedFold: {
  /**
   * Starts a segmented fold named `name` (a JS identifier: the accessor in `ctx.folds`). It is
   * built by `ContextFold.of(name, options)` and validated the same way.
   */
  of<const Name extends string>(
    name: Name & ValidFoldName<Name>,
    options: ContextFoldOptions,
  ): SegmentedFoldBuilder<Name>;
  /**
   * Opens a segment: returns `state` with a new segment `{ id, data }` appended (newest). A
   * repeated id opens another segment; `attach` then targets the newest one.
   */
  open<State extends AnySegmentedState>(
    state: State,
    id: string,
    data: NoInfer<SegmentDataOf<State>>,
  ): State;
  /**
   * Attaches to the **newest** segment with `id`: replaces its data with `update(data, segment)`,
   * in place (the segment keeps its position). An unknown id is ignored and `state` is returned
   * unchanged, e.g. a tool result arriving for a step a checkpoint already compacted away (the
   * checkpoint summarizes it). The same state is returned when `update` returns the same data.
   */
  attach<State extends AnySegmentedState>(
    state: State,
    id: string,
    update: NoInfer<
      (data: SegmentDataOf<State>, segment: SegmentOf<State>) => SegmentDataOf<State>
    >,
  ): State;
} = {
  of<const Name extends string>(
    name: Name & ValidFoldName<Name>,
    options: ContextFoldOptions,
  ): SegmentedFoldBuilder<Name> {
    const builder = ContextFold.of<Name>(name, options) as unknown as FoldBuilder;
    return new SegmentedFoldBuilderImpl(builder) as unknown as SegmentedFoldBuilder<Name>;
  },

  open<State extends AnySegmentedState>(
    state: State,
    id: string,
    data: SegmentDataOf<State>,
  ): State {
    return { ...state, segments: [...state.segments, { id, data }] };
  },

  attach<State extends AnySegmentedState>(
    state: State,
    id: string,
    update: (data: SegmentDataOf<State>, segment: SegmentOf<State>) => SegmentDataOf<State>,
  ): State {
    const { segments } = state;
    for (let index = segments.length - 1; index >= 0; index--) {
      const segment = segments[index] as SegmentOf<State>;
      if (segment.id !== id) continue;
      const data = update(segment.data, segment);
      if (Object.is(data, segment.data)) return state;
      const next = [...segments];
      next[index] = { ...segment, data };
      return { ...state, segments: next };
    }
    return state;
  },
};
