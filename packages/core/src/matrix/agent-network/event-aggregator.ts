import type { Schema as S } from 'effect';
import type { AnyContextFold } from '../context/context-fold.js';
import {
  addFolds,
  createFoldReader,
  type FoldReadAccessors,
  type FoldReader,
  foldAccessors,
  type UniqueFolds,
} from '../context/fold-reader.js';
import { type EmitValidationError, guardEmit } from '../validation.js';
import type { AgentNetworkEventDef, EventMeta } from './agent-network-event.js';
import { type EventHistory, emptyEventHistory } from './history.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

type EventEnvelope<E extends EventDef> =
  E extends AgentNetworkEventDef<infer N, infer PS>
    ? { name: N; meta: EventMeta; payload: S.Schema.Type<PS> }
    : never;

type EmitPayload<E extends EventDef> =
  E extends AgentNetworkEventDef<infer N, infer PS>
    ? { name: N; payload: S.Schema.Type<PS> }
    : never;

type EmitWhenFn<TTriggerEvent, TFolds extends AnyContextFold = never> = (ctx: {
  triggerEvent: TTriggerEvent;
  /** Durable event history of the run and its context (see `EventHistory`). */
  history: EventHistory;
  /** The `.folds([...])` folds, by name, read-only (see `AgentFactory.folds`; no `compact`). */
  folds: FoldReadAccessors<TFolds>;
}) => boolean | Promise<boolean>;

type MapToEmitFn<TTriggerEvent, TEmitEvent, TFolds extends AnyContextFold = never> = (ctx: {
  triggerEvent: TTriggerEvent;
  emit: (event: TEmitEvent) => void;
  /** Durable event history of the run and its context (see `EventHistory`). */
  history: EventHistory;
  /** The `.folds([...])` folds, by name, read-only (see `AgentFactory.folds`; no `compact`). */
  folds: FoldReadAccessors<TFolds>;
}) => void | Promise<void>;

type ConstructorParams<TListensTo extends EventDef, TEmits extends EventDef> = {
  listensTo?: ReadonlyArray<TListensTo>;
  emits?: ReadonlyArray<TEmits>;
  // Declared for fewer folds than later `.folds()` calls add: its ctx then has extra accessors.
  emitWhen?: EmitWhenFn<EventEnvelope<TListensTo>, never>;
  folds?: ReadonlyArray<AnyContextFold>;
};

export class EventAggregator<
  TListensTo extends EventDef = never,
  TEmits extends EventDef = never,
  TFolds extends AnyContextFold = never,
> {
  private _listensTo: ReadonlyArray<TListensTo>;
  private _emits: ReadonlyArray<TEmits>;
  private _emitWhen: EmitWhenFn<EventEnvelope<TListensTo>, never> | undefined;
  private _folds: ReadonlyArray<AnyContextFold>;

  private constructor({
    listensTo = [],
    emits = [],
    emitWhen,
    folds = [],
  }: ConstructorParams<TListensTo, TEmits>) {
    this._listensTo = listensTo;
    this._emits = emits;
    this._emitWhen = emitWhen;
    this._folds = folds;
  }

  private state(): ConstructorParams<TListensTo, TEmits> {
    return {
      listensTo: this._listensTo,
      emits: this._emits,
      emitWhen: this._emitWhen,
      folds: this._folds,
    };
  }

  static listensTo<E extends EventDef>(events: Array<E>): EventAggregator<E, never, never> {
    return new EventAggregator<E, never, never>({ listensTo: [...events] });
  }

  emits<E extends EventDef>(events: Array<E>): EventAggregator<TListensTo, TEmits | E, TFolds> {
    return new EventAggregator<TListensTo, TEmits | E, TFolds>({
      ...this.state(),
      emits: [...this._emits, ...events] as ReadonlyArray<TEmits | E>,
    });
  }

  /**
   * Adds context folds that `emitWhen` and `mapToEmit` read through `ctx.folds`, by name.
   * Accumulates; rejects what `AgentFactory.folds` rejects (views included).
   */
  folds<const Folds extends ReadonlyArray<AnyContextFold>>(
    folds: Folds & UniqueFolds<Folds, TFolds['name']>,
  ): EventAggregator<TListensTo, TEmits, TFolds | Folds[number]> {
    return new EventAggregator<TListensTo, TEmits, TFolds | Folds[number]>({
      ...this.state(),
      folds: addFolds(this._folds, folds, 'EventAggregator.folds'),
    });
  }

  emitWhen(
    fn: EmitWhenFn<EventEnvelope<TListensTo>, TFolds>,
  ): EventAggregator<TListensTo, TEmits, TFolds> {
    return new EventAggregator<TListensTo, TEmits, TFolds>({
      ...this.state(),
      emitWhen: fn as EmitWhenFn<EventEnvelope<TListensTo>, never>,
    });
  }

  mapToEmit(
    fn: MapToEmitFn<EventEnvelope<TListensTo>, EmitPayload<TEmits>, TFolds>,
  ): EventAggregatorInstance<EventEnvelope<TListensTo>, EmitPayload<TEmits>, TFolds> {
    const transientEvents = [...this._listensTo, ...this._emits]
      .filter((eventDef) => eventDef.transient)
      .map((eventDef) => eventDef.name);
    return new EventAggregatorInstance<EventEnvelope<TListensTo>, EmitPayload<TEmits>, TFolds>({
      listensTo: this._listensTo.map((eventDef) => eventDef.name),
      listensToEvents: this._listensTo,
      emits: this._emits,
      transientEvents: [...new Set(transientEvents)],
      emitWhen: this._emitWhen ?? (() => true),
      mapToEmit: fn,
      folds: this._folds,
    });
  }
}

type EventAggregatorInstanceCtor<TTriggerEvent, TEmitEvent, TFolds extends AnyContextFold> = {
  listensTo: ReadonlyArray<string>;
  /** Definitions of the events the aggregator listens to. */
  listensToEvents?: ReadonlyArray<EventDef>;
  /** The events the aggregator may emit; its emits are checked against them. */
  emits?: ReadonlyArray<EventDef>;
  /** Names of the transient events the aggregator listens to or emits. */
  transientEvents?: ReadonlyArray<string>;
  emitWhen: EmitWhenFn<TTriggerEvent, TFolds>;
  mapToEmit: MapToEmitFn<TTriggerEvent, TEmitEvent, TFolds>;
  /** The `.folds([...])` folds, read through `ctx.folds`. */
  folds?: ReadonlyArray<AnyContextFold>;
};

export class EventAggregatorInstance<
  TTriggerEvent,
  TEmitEvent,
  TFolds extends AnyContextFold = never,
> {
  #id: string;
  #listensTo: ReadonlyArray<string>;
  #listensToEvents: ReadonlyArray<EventDef>;
  #emits: ReadonlyArray<EventDef>;
  #transientEvents: ReadonlyArray<string>;
  #emitWhen: EmitWhenFn<TTriggerEvent, TFolds>;
  #mapToEmit: MapToEmitFn<TTriggerEvent, TEmitEvent, TFolds>;
  #folds: ReadonlyArray<AnyContextFold>;

  constructor({
    listensTo,
    listensToEvents = [],
    emits = [],
    transientEvents = [],
    emitWhen,
    mapToEmit,
    folds = [],
  }: EventAggregatorInstanceCtor<TTriggerEvent, TEmitEvent, TFolds>) {
    this.#id = `event-aggregator-${crypto.randomUUID()}`;
    this.#listensTo = listensTo;
    this.#listensToEvents = listensToEvents;
    this.#emits = emits;
    this.#transientEvents = transientEvents;
    this.#emitWhen = emitWhen;
    this.#mapToEmit = mapToEmit;
    this.#folds = folds;
  }

  /** The folds `ctx.folds` reads (`.folds([...])`), in declaration order. */
  getFolds(): ReadonlyArray<AnyContextFold> {
    return this.#folds;
  }

  getId(): string {
    return this.#id;
  }

  getListensTo(): readonly string[] {
    return this.#listensTo;
  }

  /** Definitions of the events this aggregator listens to. */
  getListensToEvents(): ReadonlyArray<EventDef> {
    return this.#listensToEvents;
  }

  /** Events this aggregator may emit (its declared `emits`). */
  getEmits(): ReadonlyArray<EventDef> {
    return this.#emits;
  }

  /** Names of the transient events this aggregator listens to or emits. */
  getTransientEvents(): readonly string[] {
    return this.#transientEvents;
  }

  async invoke(options?: {
    triggerEvent?: TTriggerEvent;
    emit?: (event: TEmitEvent) => void;
    history?: EventHistory;
    /** Reads `ctx.folds`; a network passes a cached one. Without it, reads fold `history`. */
    foldReader?: FoldReader;
  }): Promise<void> {
    const { triggerEvent, emit } = options ?? {};
    const history = options?.history ?? emptyEventHistory;
    const folds = foldAccessors(
      this.#folds as ReadonlyArray<TFolds>,
      options?.foldReader ?? createFoldReader({ history }),
      { compact: false },
    );

    if (triggerEvent == null) {
      return;
    }

    // An invalid emit fails the invocation even when `mapToEmit` catches it.
    let invalidEmit: EmitValidationError | undefined;
    const emitFn = guardEmit(
      emit ??
        ((_event: TEmitEvent): void => {
          // no-op – will be wired by the network at runtime
        }),
      {
        emits: this.#emits,
        source: { agentId: this.#id },
        onInvalidEmit: (error) => {
          invalidEmit ??= error;
        },
      },
    );

    const shouldEmit = await this.#emitWhen({ triggerEvent, history, folds });

    if (!shouldEmit) {
      return;
    }

    try {
      await this.#mapToEmit({ triggerEvent, emit: emitFn, history, folds });
    } catch (error) {
      throw invalidEmit ?? error;
    }
    if (invalidEmit) throw invalidEmit;
  }
}
