import { Either, type Schema as S } from 'effect';
import { Agent, type AgentRunControls, type EmitAndAwaitFn } from './agent.js';
import type { AgentNetworkEventDef, EventMeta } from './agent-network/agent-network-event.js';
import type { EventHistory } from './agent-network/history.js';
import type { AnyContextFold } from './context/context-fold.js';
import { addFolds, type FoldAccessors, type UniqueFolds } from './context/fold-reader.js';
import {
  assertUniqueLayerNames,
  type DependencyLayerDef,
  type LayersFromDeps,
  mergeDependencyLayers,
  toLayerArray,
} from './dependency-layer.js';
import type { Principal } from './principal.js';
import type { AgentToolCollection, AnyToolDefinition, ToolDeps } from './tool.js';
import { toToolArray } from './tool.js';
import type { RunTraceScope } from './tracing/network-tracer.js';
import type { BaseSchemaDefinition } from './types.js';
import { AgentParamsError, decodeOrAccept } from './validation.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/** Extracts the envelope type (name, meta, payload) from an event definition */
export type EventEnvelope<E extends EventDef> =
  E extends AgentNetworkEventDef<infer N, infer PS>
    ? { name: N; meta: EventMeta; payload: S.Schema.Type<PS> }
    : never;

/** What the user passes to emit() – no meta required */
export type EmitPayload<E extends EventDef> =
  E extends AgentNetworkEventDef<infer N, infer PS>
    ? { name: N; payload: S.Schema.Type<PS> }
    : never;

/** Options of `.emits([...], options)`. */
export type EmitsOptions = {
  /**
   * The events only answer an `emitAndAwait` (matched by the waiting agent, not by a listener):
   * the wiring check does not report them as unconsumed.
   */
  readonly reply?: boolean;
};

/** Internal logic function */
type LogicFn<
  TParams,
  TTriggerEvent,
  TEmitEvent,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>,
  TTools extends AnyToolDefinition,
  TFolds extends AnyContextFold,
> = (
  ctx: {
    params: TParams;
    triggerEvent: TTriggerEvent;
    /**
     * Publishes one of the agent's declared `emits`, its payload decoded with the event's schema.
     * Throws `EmitValidationError` for an undeclared event, an invalid payload or an event none of
     * its channels accepts; the invocation then fails even if the error is caught.
     */
    emit: (event: TEmitEvent) => void;
    /** Like `emit`, then waits for a matching reply; rejects with `EmitValidationError` likewise. */
    emitAndAwait: EmitAndAwaitFn<TEmitEvent>;
    layers: LayersFromDeps<TDeps>;
    tools: AgentToolCollection<TTools, TDeps, TEmitEvent>;
    /** Durable event history of the run and its context, read on demand (see `EventHistory`). */
    history: EventHistory;
    /**
     * The `.folds([...])` folds, by name: `await folds.conversation()` folds the context's
     * events into the fold's state (cached in a network, so only new events are folded) and
     * returns it, read-only (`FoldReadStateOf`: it may be the cached state, shared by every
     * reader); pass it to a view (`ContextView.of`) to trim it to a budget. Every call reads
     * again, so a read after `emitAndAwait` sees the events published meanwhile.
     * `folds.<name>.compact(...)` replaces a fold's state for good (see `FoldCompact`).
     */
    folds: FoldAccessors<TFolds>;
    /** Who the run acts for (from `auth`); `undefined` for anonymous runs. */
    principal: Principal | undefined;
    tracing: RunTraceScope;
  } & AgentRunControls,
) => Promise<void>;

type ConstructorParams<
  TParams,
  TListensTo extends EventDef,
  TEmits extends EventDef,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>,
  TTools extends AnyToolDefinition,
  TFolds extends AnyContextFold,
> = {
  logic?: LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools, TFolds>;
  paramsSchema?: BaseSchemaDefinition;
  listensTo?: ReadonlyArray<TListensTo>;
  emits?: ReadonlyArray<TEmits>;
  /** Names of the `emits` declared with `{ reply: true }`. */
  replyEvents?: ReadonlyArray<string>;
  dependencyLayers?: ReadonlyArray<TDeps>;
  tools?: ReadonlyArray<TTools>;
  concurrency?: number;
  folds?: ReadonlyArray<AnyContextFold>;
};

export class AgentFactory<
  TParams = unknown,
  TListensTo extends EventDef = never,
  TEmits extends EventDef = never,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
  TTools extends AnyToolDefinition = never,
  TFolds extends AnyContextFold = never,
> {
  private _listensTo: ReadonlyArray<TListensTo>;
  private _emits: ReadonlyArray<TEmits>;
  private _replyEvents: ReadonlyArray<string>;
  private _logic:
    | LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools, TFolds>
    | undefined;
  private _paramsSchema: BaseSchemaDefinition | undefined;
  private _dependencyLayers: ReadonlyArray<TDeps>;
  private _tools: ReadonlyArray<TTools>;
  private _concurrency: number | undefined;
  private _folds: ReadonlyArray<AnyContextFold>;

  private constructor({
    logic,
    paramsSchema,
    listensTo = [],
    emits = [],
    replyEvents = [],
    dependencyLayers = [],
    tools = [],
    concurrency,
    folds = [],
  }: ConstructorParams<TParams, TListensTo, TEmits, TDeps, TTools, TFolds>) {
    this._logic = logic;
    this._paramsSchema = paramsSchema;
    this._listensTo = listensTo;
    this._emits = emits;
    this._replyEvents = replyEvents;
    this._dependencyLayers = dependencyLayers;
    this._tools = tools;
    this._concurrency = concurrency;
    this._folds = folds;
  }

  private getConstructorState(): ConstructorParams<
    TParams,
    TListensTo,
    TEmits,
    TDeps,
    TTools,
    TFolds
  > {
    return {
      logic: this._logic,
      paramsSchema: this._paramsSchema,
      listensTo: this._listensTo,
      emits: this._emits,
      replyEvents: this._replyEvents,
      dependencyLayers: this._dependencyLayers,
      tools: this._tools,
      concurrency: this._concurrency,
      folds: this._folds,
    };
  }

  /** Union of all event definitions this agent listens to */
  getListensTo(): ReadonlyArray<TListensTo> {
    return this._listensTo;
  }

  /** Union of all event definitions this agent can emit */
  getEmits(): ReadonlyArray<TEmits> {
    return this._emits;
  }

  getDependencyLayers(): ReadonlyArray<TDeps> {
    return this._dependencyLayers;
  }

  getTools(): ReadonlyArray<TTools> {
    return this._tools;
  }

  getLogic():
    | LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools, TFolds>
    | undefined {
    return this._logic;
  }

  /** The folds declared with `.folds([...])`, in order. */
  getFolds(): ReadonlyArray<TFolds> {
    return this._folds as ReadonlyArray<TFolds>;
  }

  static run(): AgentFactory<unknown, never, never, never, never, never> {
    return new AgentFactory<unknown, never, never, never, never, never>({});
  }

  params<TSchema extends BaseSchemaDefinition>(
    params: TSchema,
  ): AgentFactory<TSchema['Type'], TListensTo, TEmits, TDeps, TTools, TFolds> {
    const { logic, ...rest } = this.getConstructorState();

    return new AgentFactory({
      ...rest,
      logic: logic as LogicFn<
        TSchema['Type'],
        EventEnvelope<TListensTo>,
        EmitPayload<TEmits>,
        TDeps,
        TTools,
        TFolds
      >,
      paramsSchema: params,
    });
  }

  listensTo<E extends EventDef>(
    events: Array<E>,
  ): AgentFactory<TParams, TListensTo | E, TEmits, TDeps, TTools, TFolds> {
    return new AgentFactory<TParams, TListensTo | E, TEmits, TDeps, TTools, TFolds>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo | E,
        TEmits,
        TDeps,
        TTools,
        TFolds
      >),
      listensTo: [...this._listensTo, ...events] as ReadonlyArray<TListensTo | E>,
    });
  }

  /**
   * Declares events the agent may emit. With `{ reply: true }` they only answer an
   * `emitAndAwait`, so the wiring check does not expect a listener for them.
   */
  emits<E extends EventDef>(
    events: Array<E>,
    options?: EmitsOptions,
  ): AgentFactory<TParams, TListensTo, TEmits | E, TDeps, TTools, TFolds> {
    return new AgentFactory<TParams, TListensTo, TEmits | E, TDeps, TTools, TFolds>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits | E,
        TDeps,
        TTools,
        TFolds
      >),
      emits: [...this._emits, ...events] as ReadonlyArray<TEmits | E>,
      replyEvents: options?.reply
        ? [...this._replyEvents, ...events.map((e) => e.name)]
        : this._replyEvents,
    });
  }

  dependsOn<D extends DependencyLayerDef<string, unknown, S.Schema.Any>>(
    ...layers: [D, ...D[]] | [ReadonlyArray<D>]
  ): AgentFactory<TParams, TListensTo, TEmits, TDeps | D, TTools, TFolds> {
    const normalized = toLayerArray(layers);
    const allLayers = [...this._dependencyLayers, ...normalized];
    assertUniqueLayerNames(allLayers);
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps | D, TTools, TFolds>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits,
        TDeps | D,
        TTools,
        TFolds
      >),
      dependencyLayers: allLayers as unknown as ReadonlyArray<TDeps | D>,
    });
  }

  tools<T extends AnyToolDefinition>(
    ...tools: [T, ...T[]] | [ReadonlyArray<T>]
  ): AgentFactory<TParams, TListensTo, TEmits, TDeps | ToolDeps<T>, TTools | T, TFolds> {
    const normalized = toToolArray(tools);
    const toolLayers = normalized.flatMap((tool) => tool.dependencyLayers);
    const allLayers = mergeDependencyLayers([...this._dependencyLayers, ...toolLayers]);
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps | ToolDeps<T>, TTools | T, TFolds>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits,
        TDeps | ToolDeps<T>,
        TTools | T,
        TFolds
      >),
      dependencyLayers: allLayers as unknown as ReadonlyArray<TDeps | ToolDeps<T>>,
      tools: [...this._tools, ...normalized] as ReadonlyArray<TTools | T>,
    });
  }

  /**
   * Caps how many invocations of the produced agent run at once across all runs of a network,
   * e.g. to stay within a provider's rate limit. Within one run an agent always handles its
   * events one at a time, in order. Default: unbounded. `limit` must be a positive integer or
   * `Infinity`.
   */
  concurrency(limit: number): AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools, TFolds> {
    if (!(limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit > 0))) {
      throw new Error(
        `AgentFactory.concurrency: limit must be a positive integer or Infinity, got ${limit}`,
      );
    }
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools, TFolds>({
      ...this.getConstructorState(),
      concurrency: limit,
    });
  }

  /**
   * Adds context folds (`ContextFold`, `SegmentedFold`) the logic reads through `ctx.folds`, each
   * by its name: `.folds([Conversation])` → `await folds.conversation()`, the fold's state,
   * read-only. Accumulates over calls. In a network the folded state is cached, so a read only
   * folds the events published since the previous one; outside one, a read folds the `history`
   * passed to `invoke()`. Views are not declared here: call one with the state a read returns.
   * A context-scoped fold with a `state` schema can also be compacted in a network
   * (`await folds.conversation.compact(...)`, see `FoldCompact`). Give each fold in a network its
   * own name: different compactable folds of one name and version would share checkpoints, which
   * the wiring check rejects (`fold-checkpoint-shared`).
   *
   * Throws `ContextFoldDefinitionError` for anything that is not a fold (a view included) or a
   * fold that reads no events (no handler), and `Error` for a name used twice (also a type error).
   */
  folds<const Folds extends ReadonlyArray<AnyContextFold>>(
    folds: Folds & UniqueFolds<Folds, TFolds['name']>,
  ): AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools, TFolds | Folds[number]> {
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools, TFolds | Folds[number]>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits,
        TDeps,
        TTools,
        TFolds | Folds[number]
      >),
      folds: addFolds(this._folds, folds, 'AgentFactory.folds'),
    });
  }

  logic(
    fn: LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools, TFolds>,
  ): AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools, TFolds> {
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools, TFolds>({
      ...this.getConstructorState(),
      logic: fn,
    });
  }

  private decodeParams(params: TParams): TParams {
    if (!this._paramsSchema) return params;
    const decoded = decodeOrAccept(this._paramsSchema, params);
    if (Either.isLeft(decoded)) throw new AgentParamsError(decoded.left);
    return decoded.right as TParams;
  }

  /**
   * Creates an agent with `params`. With a `params()` schema they are validated (and decoded, so
   * schema transformations apply) first; invalid params throw `AgentParamsError`.
   */
  produce(
    params: TParams,
  ): Agent<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools, TFolds> {
    const logic = this._logic;
    if (!logic) {
      throw new Error('AgentFactory.produce requires logic() to be called before produce()');
    }
    const decodedParams = this.decodeParams(params);
    const listensTo = this._listensTo.map((e) => e.name);
    const transientEvents = [...this._listensTo, ...this._emits]
      .filter((e) => e.transient)
      .map((e) => e.name);
    return new Agent<
      TParams,
      EventEnvelope<TListensTo>,
      EmitPayload<TEmits>,
      TDeps,
      TTools,
      TFolds
    >(logic, decodedParams, listensTo, this._dependencyLayers, this._tools, {
      concurrency: this._concurrency,
      transientEvents: [...new Set(transientEvents)],
      emits: this._emits,
      replyEvents: this._replyEvents,
      listensToEvents: this._listensTo,
      folds: this._folds,
    });
  }
}
