import type { Schema as S } from 'effect';
import type * as Duration from 'effect/Duration';
import type { AgentNetworkEventDef } from './agent-network/agent-network-event.js';
import type { Envelope } from './agent-network/event-plane.js';
import { type EventHistory, emptyEventHistory } from './agent-network/history.js';
import type { FoldSource } from './context/context-fold.js';
import {
  createFoldReader,
  type FoldAccessors,
  type FoldReader,
  foldAccessors,
} from './context/fold-reader.js';
import type { DependencyLayerDef, LayersFromDeps } from './dependency-layer.js';
import type { Principal } from './principal.js';
import { AgentToolCollection, type AnyToolDefinition } from './tool.js';
import { noopRunTraceScope, type RunTraceScope } from './tracing/network-tracer.js';
import type { UsageReport, UsageReporter } from './usage.js';
import { type EmitValidationError, guardEmit, guardEmitAndAwait } from './validation.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

export type EmitAndAwaitFn<TEvent = never> = (
  event: TEvent,
  match: (reply: Envelope) => boolean,
  options?: { timeout?: Duration.DurationInput },
) => Promise<Envelope>;

type LogicFn<
  TParams,
  TTriggerEvent,
  TEmitEvent,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>,
  TTools extends AnyToolDefinition,
  TFolds extends FoldSource = never,
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
     * The `.folds([...])` sources, by name: `await folds.conversation()` folds the context's
     * events into the fold's state (cached in a network, so only new events are folded) and
     * returns it, or the view's result. Every call reads again, so a read after `emitAndAwait`
     * sees the events published meanwhile. In a network, a read also includes every event this
     * invocation emitted before it (it waits until they are stored), and rejects with
     * `AgentAbortedError` when one of them never will be because the run is over.
     */
    folds: FoldAccessors<TFolds>;
    /** Who the run acts for (from `auth`); `undefined` for anonymous runs. */
    principal: Principal | undefined;
    tracing: RunTraceScope;
  } & AgentRunControls,
) => Promise<void>;

/** Run lifecycle controls every agent invocation receives. */
export type AgentRunControls = {
  /**
   * Aborted when the invocation's run ends (completed, failed, cancelled, timed out) or the
   * network shuts down. Pass it to fetch/LLM calls so they stop with the run.
   */
  signal: AbortSignal;
  /** Ends the run as completed, after this invocation's earlier emits are published. */
  complete: () => void;
  /** Ends the run as failed with `error`, whatever the network's `onAgentError` policy. */
  fail: (error: unknown) => void;
  /**
   * Records what a model call used (tokens, cost) on the run: summed per run and model, passed
   * to the tracer's `onUsage`, included in the run-end event, and checked against the run's
   * `maxTokens` / `maxCostUsd`. A no-op outside a network.
   */
  reportUsage: (usage: UsageReport) => void;
};

/** Runtime settings an agent carries into a network. */
export type AgentRuntimeOptions = {
  /** Max concurrent invocations across runs (see `AgentFactory.concurrency`). Default unbounded. */
  concurrency?: number;
  /** Names of the transient events this agent listens to or emits. */
  transientEvents?: readonly string[];
  /**
   * The events the agent may emit. Every `emit` / `emitAndAwait` is checked against them (and
   * the payload decoded with the event's schema); without any, the agent may emit nothing.
   */
  emits?: ReadonlyArray<EventDef>;
  /** Definitions of the events the agent listens to (their names are `listensTo`). */
  listensToEvents?: ReadonlyArray<EventDef>;
  /** Names of the `emits` that only answer an `emitAndAwait` (see `EmitsOptions.reply`). */
  replyEvents?: readonly string[];
  /** The `.folds([...])` sources, read through `ctx.folds`. */
  folds?: ReadonlyArray<FoldSource>;
};

export class Agent<
  TParams,
  TTriggerEvent = never,
  TEmitEvent = never,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
  TTools extends AnyToolDefinition = never,
  TFolds extends FoldSource = never,
> {
  #params: TParams;
  #logic: LogicFn<TParams, TTriggerEvent, TEmitEvent, TDeps, TTools, TFolds>;
  #id: string;
  #listensTo: readonly string[];
  #dependencyLayers: ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>>;
  #tools: ReadonlyArray<TTools>;
  #concurrency: number;
  #transientEvents: readonly string[];
  #emits: ReadonlyArray<EventDef>;
  #listensToEvents: ReadonlyArray<EventDef>;
  #replyEvents: readonly string[];
  #folds: ReadonlyArray<FoldSource>;

  constructor(
    logic: LogicFn<TParams, TTriggerEvent, TEmitEvent, TDeps, TTools, TFolds>,
    params: TParams,
    listensTo?: readonly string[],
    dependencyLayers?: ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>>,
    tools?: ReadonlyArray<TTools>,
    runtimeOptions?: AgentRuntimeOptions,
  ) {
    this.#logic = logic;
    this.#params = params;
    this.#id = `agent-${crypto.randomUUID()}`;
    this.#listensTo = listensTo ?? [];
    this.#dependencyLayers = dependencyLayers ?? [];
    this.#tools = tools ?? [];
    this.#concurrency = runtimeOptions?.concurrency ?? Number.POSITIVE_INFINITY;
    this.#transientEvents = runtimeOptions?.transientEvents ?? [];
    this.#emits = runtimeOptions?.emits ?? [];
    this.#listensToEvents = runtimeOptions?.listensToEvents ?? [];
    this.#replyEvents = runtimeOptions?.replyEvents ?? [];
    this.#folds = runtimeOptions?.folds ?? [];
  }

  /** The sources `ctx.folds` reads (`.folds([...])`), in declaration order. */
  getFolds(): ReadonlyArray<FoldSource> {
    return this.#folds;
  }

  /** Emitted events (its own and its tools') that only answer an `emitAndAwait`. */
  getReplyEvents(): readonly string[] {
    const all = [...this.#replyEvents, ...this.#tools.flatMap((tool) => tool.replyEvents ?? [])];
    return [...new Set(all)];
  }

  /** Events this agent and its tools may emit (their declared `emits`). */
  getEmits(): ReadonlyArray<EventDef> {
    const all = [...this.#emits, ...this.#tools.flatMap((tool) => tool.emitEvents)];
    return all.filter((def, i) => all.findIndex((other) => other.name === def.name) === i);
  }

  /** Definitions of the events this agent listens to. */
  getListensToEvents(): ReadonlyArray<EventDef> {
    return this.#listensToEvents;
  }

  /** Max concurrent invocations of this agent across runs; `Infinity` when uncapped. */
  getConcurrency(): number {
    return this.#concurrency;
  }

  /** Names of the transient events this agent listens to or emits (its tools' emits included). */
  getTransientEvents(): readonly string[] {
    const fromTools = this.#tools.flatMap((tool) =>
      tool.emitEvents.filter((event) => event.transient).map((event) => event.name),
    );
    return [...new Set([...this.#transientEvents, ...fromTools])];
  }

  getListensTo(): readonly string[] {
    return this.#listensTo;
  }

  getDependencyLayers(): ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>> {
    return this.#dependencyLayers;
  }

  getTools(): ReadonlyArray<TTools> {
    return this.#tools;
  }

  async invoke(options?: {
    triggerEvent?: TTriggerEvent;
    emit?: (event: TEmitEvent) => void;
    emitAndAwait?: EmitAndAwaitFn<TEmitEvent>;
    layers?: LayersFromDeps<TDeps>;
    history?: EventHistory;
    /**
     * Reads `ctx.folds`; a network passes one backed by its fold cache. Without it, every read
     * folds `history` from scratch.
     */
    foldReader?: FoldReader;
    principal?: Principal;
    tracing?: RunTraceScope;
    /** Aborts the invocation. Standalone calls without one get a signal that never aborts. */
    signal?: AbortSignal;
    complete?: () => void;
    fail?: (error: unknown) => void;
    reportUsage?: UsageReporter;
  }): Promise<void> {
    const { triggerEvent, emit, emitAndAwait, layers, history, principal, tracing } = options ?? {};
    const layersObj = (layers ?? {}) as LayersFromDeps<TDeps>;
    const signal = options?.signal ?? new AbortController().signal;
    const complete =
      options?.complete ??
      ((): void => {
        // no-op – there is no run to end outside a network
      });
    // Outside a network, `fail()` rejects the invocation once logic returns.
    let standaloneFailure: { error: unknown } | undefined;
    const fail =
      options?.fail ??
      ((error: unknown): void => {
        standaloneFailure ??= { error };
      });

    const reportUsage: UsageReporter =
      options?.reportUsage ??
      ((): void => {
        // no-op – there is no run to record usage on outside a network
      });

    const rawEmit =
      emit ??
      ((_event: TEmitEvent): void => {
        // no-op – will be wired by the network at runtime
      });
    const rawEmitAndAwait =
      emitAndAwait ??
      (async (): Promise<Envelope> => {
        throw new Error(
          'emitAndAwait is only available when the agent is running in an event plane',
        );
      });
    // An invalid emit fails the invocation even when the logic catches it.
    let invalidEmit: EmitValidationError | undefined;
    const onInvalidEmit = (error: EmitValidationError): void => {
      invalidEmit ??= error;
    };
    const guard = { emits: this.#emits, source: { agentId: this.#id }, onInvalidEmit };
    const emitFn = guardEmit(rawEmit, guard);
    const emitAndAwaitFn = guardEmitAndAwait(rawEmitAndAwait, guard);

    const triggerMeta =
      triggerEvent &&
      typeof triggerEvent === 'object' &&
      'meta' in triggerEvent &&
      triggerEvent.meta &&
      typeof triggerEvent.meta === 'object'
        ? (triggerEvent.meta as { runId?: string; contextId?: string })
        : undefined;

    const tracingScope = tracing ?? noopRunTraceScope(triggerMeta);
    try {
      await this.#logic({
        params: this.#params,
        triggerEvent: triggerEvent ?? (undefined as TTriggerEvent),
        emit: emitFn,
        emitAndAwait: emitAndAwaitFn,
        layers: layersObj,
        // Tools check emits against their own declared events.
        tools: new AgentToolCollection(this.#tools, layersObj, rawEmit, rawEmitAndAwait, {
          agentId: this.#id,
          onInvalidEmit,
          signal,
          complete,
          tracing: tracingScope,
          reportUsage,
          principal,
        }),
        history: history ?? emptyEventHistory,
        folds: foldAccessors(
          this.#folds as ReadonlyArray<TFolds>,
          options?.foldReader ?? createFoldReader({ history: history ?? emptyEventHistory }),
        ),
        principal,
        tracing: tracingScope,
        signal,
        complete,
        fail,
        reportUsage: (usage) => reportUsage(usage),
      });
    } catch (error) {
      throw invalidEmit ?? error;
    }
    if (invalidEmit) throw invalidEmit;
    if (standaloneFailure) throw standaloneFailure.error;
  }

  getId(): string {
    return this.#id;
  }
}
