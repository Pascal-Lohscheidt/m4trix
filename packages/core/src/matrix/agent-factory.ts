import { Schema as S } from 'effect';
import { Agent } from './agent';
import {
  AgentNetworkEventDef,
  type ContextEvents,
  type EventMeta,
  type RunEvents,
} from './agent-network/agent-network-event';
import { BaseSchemaDefintion } from './types';

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
type LogicFn<TParams, TTriggerEvent, TEmitEvent> = (ctx: {
  params: TParams;
  triggerEvent: TTriggerEvent;
  emit: (event: TEmitEvent) => void;
  runEvents: RunEvents;
  contextEvents: ContextEvents;
}) => Promise<void>;

type ConstructorParams<
  TParams,
  TListensTo extends EventDef,
  TEmits extends EventDef,
> = {
  logic?: LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>>;
  paramsSchema?: BaseSchemaDefintion;
  listensTo?: ReadonlyArray<TListensTo>;
  emits?: ReadonlyArray<TEmits>;
};

export class AgentFactory<
  TParams = unknown,
  TListensTo extends EventDef = never,
  TEmits extends EventDef = never,
> {
  private _listensTo: ReadonlyArray<TListensTo>;
  private _emits: ReadonlyArray<TEmits>;
  private _logic:
    | LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>>
    | undefined;
  private _paramsSchema: BaseSchemaDefintion | undefined;

  private constructor({
    logic,
    paramsSchema,
    listensTo = [],
    emits = [],
  }: ConstructorParams<TParams, TListensTo, TEmits>) {
    this._logic = logic;
    this._paramsSchema = paramsSchema;
    this._listensTo = listensTo;
    this._emits = emits;
  }

  private getConstructorState(): ConstructorParams<
    TParams,
    TListensTo,
    TEmits
  > {
    return {
      logic: this._logic,
      paramsSchema: this._paramsSchema,
      listensTo: this._listensTo,
      emits: this._emits,
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

  getLogic():
    | LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>>
    | undefined {
    return this._logic;
  }

  static run(): AgentFactory<unknown, never, never> {
    return new AgentFactory<unknown, never, never>({});
  }

  params<TSchema extends BaseSchemaDefintion>(
    params: TSchema,
  ): AgentFactory<TSchema['Type'], TListensTo, TEmits> {
    const { logic, ...rest } = this.getConstructorState();

    return new AgentFactory({
      ...rest,
      logic: logic as LogicFn<
        TSchema['Type'],
        EventEnvelope<TListensTo>,
        EmitPayload<TEmits>
      >,
      paramsSchema: params,
    });
  }

  listensTo<E extends EventDef>(
    events: Array<E>,
  ): AgentFactory<TParams, TListensTo | E, TEmits> {
    return new AgentFactory<TParams, TListensTo | E, TEmits>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo | E,
        TEmits
      >),
      listensTo: [...this._listensTo, ...events] as ReadonlyArray<
        TListensTo | E
      >,
    });
  }

  emits<E extends EventDef>(
    events: Array<E>,
  ): AgentFactory<TParams, TListensTo, TEmits | E> {
    return new AgentFactory<TParams, TListensTo, TEmits | E>({
      ...(this.getConstructorState() as unknown as ConstructorParams<
        TParams,
        TListensTo,
        TEmits | E
      >),
      emits: [...this._emits, ...events] as ReadonlyArray<TEmits | E>,
    });
  }

  logic(
    fn: LogicFn<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>>,
  ): AgentFactory<TParams, TListensTo, TEmits> {
    return new AgentFactory<TParams, TListensTo, TEmits>({
      ...this.getConstructorState(),
      logic: fn,
    });
  }

  produce(
    params: TParams,
  ): Agent<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>> {
    const listensTo = this._listensTo.map((e) => e.name);
    return new Agent<TParams, EventEnvelope<TListensTo>, EmitPayload<TEmits>>(
      this._logic!,
      params,
      listensTo,
    );
  }
}
