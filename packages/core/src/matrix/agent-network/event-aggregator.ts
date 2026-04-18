import { randomUUID } from 'crypto';
import type { Schema as S } from 'effect';
import type {
  AgentNetworkEventDef,
  ContextEvents,
  EventMeta,
  RunEvents,
} from './agent-network-event.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

type EventEnvelope<E extends EventDef> =
  E extends AgentNetworkEventDef<infer N, infer PS>
    ? { name: N; meta: EventMeta; payload: S.Schema.Type<PS> }
    : never;

type EmitPayload<E extends EventDef> =
  E extends AgentNetworkEventDef<infer N, infer PS>
    ? { name: N; payload: S.Schema.Type<PS> }
    : never;

type EmitWhenFn<TTriggerEvent> = (ctx: {
  triggerEvent: TTriggerEvent;
  runEvents: RunEvents;
  contextEvents: ContextEvents;
}) => boolean | Promise<boolean>;

type MapToEmitFn<TTriggerEvent, TEmitEvent> = (ctx: {
  triggerEvent: TTriggerEvent;
  emit: (event: TEmitEvent) => void;
  runEvents: RunEvents;
  contextEvents: ContextEvents;
}) => void | Promise<void>;

type ConstructorParams<TListensTo extends EventDef, TEmits extends EventDef> = {
  listensTo?: ReadonlyArray<TListensTo>;
  emits?: ReadonlyArray<TEmits>;
  emitWhen?: EmitWhenFn<EventEnvelope<TListensTo>>;
};

export class EventAggregator<TListensTo extends EventDef = never, TEmits extends EventDef = never> {
  private _listensTo: ReadonlyArray<TListensTo>;
  private _emits: ReadonlyArray<TEmits>;
  private _emitWhen: EmitWhenFn<EventEnvelope<TListensTo>> | undefined;

  private constructor({
    listensTo = [],
    emits = [],
    emitWhen,
  }: ConstructorParams<TListensTo, TEmits>) {
    this._listensTo = listensTo;
    this._emits = emits;
    this._emitWhen = emitWhen;
  }

  static listensTo<E extends EventDef>(events: Array<E>): EventAggregator<E, never> {
    return new EventAggregator<E, never>({ listensTo: [...events] });
  }

  emits<E extends EventDef>(events: Array<E>): EventAggregator<TListensTo, TEmits | E> {
    return new EventAggregator<TListensTo, TEmits | E>({
      listensTo: this._listensTo,
      emits: [...this._emits, ...events] as ReadonlyArray<TEmits | E>,
      emitWhen: this._emitWhen as EmitWhenFn<EventEnvelope<TListensTo>>,
    });
  }

  emitWhen(fn: EmitWhenFn<EventEnvelope<TListensTo>>): EventAggregator<TListensTo, TEmits> {
    return new EventAggregator<TListensTo, TEmits>({
      listensTo: this._listensTo,
      emits: this._emits,
      emitWhen: fn,
    });
  }

  mapToEmit(
    fn: MapToEmitFn<EventEnvelope<TListensTo>, EmitPayload<TEmits>>,
  ): EventAggregatorInstance<EventEnvelope<TListensTo>, EmitPayload<TEmits>> {
    return new EventAggregatorInstance<EventEnvelope<TListensTo>, EmitPayload<TEmits>>({
      listensTo: this._listensTo.map((eventDef) => eventDef.name),
      emitWhen: this._emitWhen ?? (() => true),
      mapToEmit: fn,
    });
  }
}

type EventAggregatorInstanceCtor<TTriggerEvent, TEmitEvent> = {
  listensTo: ReadonlyArray<string>;
  emitWhen: EmitWhenFn<TTriggerEvent>;
  mapToEmit: MapToEmitFn<TTriggerEvent, TEmitEvent>;
};

export class EventAggregatorInstance<TTriggerEvent, TEmitEvent> {
  #id: string;
  #listensTo: ReadonlyArray<string>;
  #emitWhen: EmitWhenFn<TTriggerEvent>;
  #mapToEmit: MapToEmitFn<TTriggerEvent, TEmitEvent>;

  constructor({
    listensTo,
    emitWhen,
    mapToEmit,
  }: EventAggregatorInstanceCtor<TTriggerEvent, TEmitEvent>) {
    this.#id = `event-aggregator-${randomUUID()}`;
    this.#listensTo = listensTo;
    this.#emitWhen = emitWhen;
    this.#mapToEmit = mapToEmit;
  }

  getId(): string {
    return this.#id;
  }

  getListensTo(): readonly string[] {
    return this.#listensTo;
  }

  async invoke(options?: {
    triggerEvent?: TTriggerEvent;
    emit?: (event: TEmitEvent) => void;
    runEvents?: RunEvents;
    contextEvents?: ContextEvents;
  }): Promise<void> {
    const { triggerEvent, emit, runEvents, contextEvents } = options ?? {};

    if (triggerEvent == null) {
      return;
    }

    const emitFn =
      emit ??
      ((_event: TEmitEvent): void => {
        // no-op – will be wired by the network at runtime
      });

    const runEventsValue = runEvents ?? [];
    const contextEventsValue = contextEvents ?? {
      all: [],
      byRun: () => [],
      map: new Map(),
    };

    const shouldEmit = await this.#emitWhen({
      triggerEvent,
      runEvents: runEventsValue,
      contextEvents: contextEventsValue,
    });

    if (!shouldEmit) {
      return;
    }

    await this.#mapToEmit({
      triggerEvent,
      emit: emitFn,
      runEvents: runEventsValue,
      contextEvents: contextEventsValue,
    });
  }
}
