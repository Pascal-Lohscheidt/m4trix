import type { Schema as S } from 'effect';
import { Agent, type EmitAndAwaitFn } from './agent.js';
import type {
  AgentNetworkEventDef,
  ContextEvents,
  EventMeta,
  RunEvents,
} from './agent-network/agent-network-event.js';
import {
  assertUniqueLayerNames,
  type DepedencyLayerDef,
  type LayersFromDeps,
  mergeDependencyLayers,
  toLayerArray,
} from './dependency-layer.js';
import type { AgentToolCollection, AnyToolDefinition, ToolDeps } from './tool.js';
import { toToolArray } from './tool.js';
import type { RunTraceScope } from './tracing/network-tracer.js';
import type { BaseSchemaDefintion } from './types.js';

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

/** Internal logic function */
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

type ConstructorParams<
  TParams,
  TListensTo extends EventDef,
  TEmits extends EventDef,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
  TTools extends AnyToolDefinition,
> = {
  logic?: LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools>;
  paramsSchema?: BaseSchemaDefintion;
  listensTo?: ReadonlyArray<TListensTo>;
  emits?: ReadonlyArray<TEmits>;
  dependencyLayers?: ReadonlyArray<TDeps>;
  tools?: ReadonlyArray<TTools>;
};

export class AgentFactory<
  TParams = unknown,
  TListensTo extends EventDef = never,
  TEmits extends EventDef = never,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
  TTools extends AnyToolDefinition = never,
> {
  private _listensTo: ReadonlyArray<TListensTo>;
  private _emits: ReadonlyArray<TEmits>;
  private _logic:
    | LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools>
    | undefined;
  private _paramsSchema: BaseSchemaDefintion | undefined;
  private _dependencyLayers: ReadonlyArray<TDeps>;
  private _tools: ReadonlyArray<TTools>;

  private constructor({
    logic,
    paramsSchema,
    listensTo = [],
    emits = [],
    dependencyLayers = [],
    tools = [],
  }: ConstructorParams<TParams, TListensTo, TEmits, TDeps, TTools>) {
    this._logic = logic;
    this._paramsSchema = paramsSchema;
    this._listensTo = listensTo;
    this._emits = emits;
    this._dependencyLayers = dependencyLayers;
    this._tools = tools;
  }

  private getConstructorState(): ConstructorParams<TParams, TListensTo, TEmits, TDeps, TTools> {
    return {
      logic: this._logic,
      paramsSchema: this._paramsSchema,
      listensTo: this._listensTo,
      emits: this._emits,
      dependencyLayers: this._dependencyLayers,
      tools: this._tools,
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
    | LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools>
    | undefined {
    return this._logic;
  }

  static run(): AgentFactory<unknown, never, never, never, never> {
    return new AgentFactory<unknown, never, never, never, never>({});
  }

  params<TSchema extends BaseSchemaDefintion>(
    params: TSchema,
  ): AgentFactory<TSchema['Type'], TListensTo, TEmits, TDeps, TTools> {
    const { logic, ...rest } = this.getConstructorState();

    return new AgentFactory({
      ...rest,
      logic: logic as LogicFn<
        TSchema['Type'],
        EventEnvelope<TListensTo>,
        EmitPayload<TEmits>,
        TDeps,
        TTools
      >,
      paramsSchema: params,
    });
  }

  listensTo<E extends EventDef>(
    events: Array<E>,
  ): AgentFactory<TParams, TListensTo | E, TEmits, TDeps, TTools> {
    return new AgentFactory<TParams, TListensTo | E, TEmits, TDeps, TTools>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo | E,
        TEmits,
        TDeps,
        TTools
      >),
      listensTo: [...this._listensTo, ...events] as ReadonlyArray<TListensTo | E>,
    });
  }

  emits<E extends EventDef>(
    events: Array<E>,
  ): AgentFactory<TParams, TListensTo, TEmits | E, TDeps, TTools> {
    return new AgentFactory<TParams, TListensTo, TEmits | E, TDeps, TTools>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits | E,
        TDeps,
        TTools
      >),
      emits: [...this._emits, ...events] as ReadonlyArray<TEmits | E>,
    });
  }

  dependsOn<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
    ...layers: [D, ...D[]] | [ReadonlyArray<D>]
  ): AgentFactory<TParams, TListensTo, TEmits, TDeps | D, TTools> {
    const normalized = toLayerArray(layers);
    const allLayers = [...this._dependencyLayers, ...normalized];
    assertUniqueLayerNames(allLayers);
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps | D, TTools>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits,
        TDeps | D,
        TTools
      >),
      dependencyLayers: allLayers as unknown as ReadonlyArray<TDeps | D>,
    });
  }

  tools<T extends AnyToolDefinition>(
    ...tools: [T, ...T[]] | [ReadonlyArray<T>]
  ): AgentFactory<TParams, TListensTo, TEmits, TDeps | ToolDeps<T>, TTools | T> {
    const normalized = toToolArray(tools);
    const toolLayers = normalized.flatMap((tool) => tool.dependencyLayers);
    const allLayers = mergeDependencyLayers([...this._dependencyLayers, ...toolLayers]);
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps | ToolDeps<T>, TTools | T>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits,
        TDeps | ToolDeps<T>,
        TTools | T
      >),
      dependencyLayers: allLayers as unknown as ReadonlyArray<TDeps | ToolDeps<T>>,
      tools: [...this._tools, ...normalized] as ReadonlyArray<TTools | T>,
    });
  }

  logic(
    fn: LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools>,
  ): AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools> {
    return new AgentFactory<TParams, TListensTo, TEmits, TDeps, TTools>({
      ...this.getConstructorState(),
      logic: fn,
    });
  }

  produce(
    params: TParams,
  ): Agent<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools> {
    const logic = this._logic;
    if (!logic) {
      throw new Error('AgentFactory.produce requires logic() to be called before produce()');
    }
    const listensTo = this._listensTo.map((e) => e.name);
    return new Agent<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>, TDeps, TTools>(
      logic,
      params,
      listensTo,
      this._dependencyLayers,
      this._tools,
    );
  }
}
