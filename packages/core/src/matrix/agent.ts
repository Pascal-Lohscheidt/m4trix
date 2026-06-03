import { randomUUID } from 'node:crypto';
import type { Schema as S } from 'effect';
import type { ContextEvents, RunEvents } from './agent-network/agent-network-event.js';
import type { Envelope } from './agent-network/event-plane.js';
import type { DepedencyLayerDef, LayersFromDeps } from './dependency-layer.js';
import { AgentToolCollection, type AnyToolDefinition } from './tool.js';
import { noopRunTraceScope, type RunTraceScope } from './tracing/network-tracer.js';
import type * as Duration from 'effect/Duration';

export type EmitAndAwaitFn<TEvent = never> = (
  event: TEvent,
  match: (reply: Envelope) => boolean,
  options?: { timeout?: Duration.DurationInput },
) => Promise<Envelope>;

type LogicFn<
  TParams,
  TTriggerEvent,
  TEmitEvent,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
  TTools extends AnyToolDefinition,
> = (ctx: {
  params: TParams;
  triggerEvent: TTriggerEvent;
  emit: (event: TEmitEvent) => void;
  emitAndAwait: EmitAndAwaitFn<TEmitEvent>;
  layers: LayersFromDeps<TDeps>;
  tools: AgentToolCollection<TTools, TDeps, TEmitEvent>;
  runEvents: RunEvents;
  contextEvents: ContextEvents;
  tracing: RunTraceScope;
}) => Promise<void>;

export class Agent<
  TParams,
  TTriggerEvent = never,
  TEmitEvent = never,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
  TTools extends AnyToolDefinition = never,
> {
  #params: TParams;
  #logic: LogicFn<TParams, TTriggerEvent, TEmitEvent, TDeps, TTools>;
  #id: string;
  #listensTo: readonly string[];
  #dependencyLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
  #tools: ReadonlyArray<TTools>;

  constructor(
    logic: LogicFn<TParams, TTriggerEvent, TEmitEvent, TDeps, TTools>,
    params: TParams,
    listensTo?: readonly string[],
    dependencyLayers?: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>,
    tools?: ReadonlyArray<TTools>,
  ) {
    this.#logic = logic;
    this.#params = params;
    this.#id = `agent-${randomUUID()}`;
    this.#listensTo = listensTo ?? [];
    this.#dependencyLayers = dependencyLayers ?? [];
    this.#tools = tools ?? [];
  }

  getListensTo(): readonly string[] {
    return this.#listensTo;
  }

  getDependencyLayers(): ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>> {
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
    runEvents?: RunEvents;
    contextEvents?: ContextEvents;
    tracing?: RunTraceScope;
  }): Promise<void> {
    const { triggerEvent, emit, emitAndAwait, layers, runEvents, contextEvents, tracing } =
      options ?? {};
    const layersObj = (layers ?? {}) as LayersFromDeps<TDeps>;

    const emitFn =
      emit ??
      ((_event: TEmitEvent): void => {
        // no-op – will be wired by the network at runtime
      });
    const emitAndAwaitFn =
      emitAndAwait ??
      (async (): Promise<Envelope> => {
        throw new Error(
          'emitAndAwait is only available when the agent is running in an event plane',
        );
      });

    const triggerMeta =
      triggerEvent &&
      typeof triggerEvent === 'object' &&
      'meta' in triggerEvent &&
      triggerEvent.meta &&
      typeof triggerEvent.meta === 'object'
        ? (triggerEvent.meta as { runId?: string; contextId?: string })
        : undefined;

    await this.#logic({
      params: this.#params,
      triggerEvent: triggerEvent ?? (undefined as TTriggerEvent),
      emit: emitFn,
      emitAndAwait: emitAndAwaitFn,
      layers: layersObj,
      tools: new AgentToolCollection(this.#tools, layersObj, emitFn, emitAndAwaitFn),
      runEvents: runEvents ?? [],
      contextEvents: contextEvents ?? {
        all: [],
        byRun: () => [],
        map: new Map(),
      },
      tracing: tracing ?? noopRunTraceScope(triggerMeta),
    });
  }

  getId(): string {
    return this.#id;
  }
}
