import { Effect, Schema as S } from 'effect';
import type { ParseError } from 'effect/ParseResult';

/** Standard meta carried by every event */
export const EventMetaSchema = S.Struct({
  runId: S.String,
  contextId: S.String,
  correlationId: S.optional(S.String),
  causationId: S.optional(S.String),
  ts: S.optional(S.Number),
});

export type EventMeta = S.Schema.Type<typeof EventMetaSchema>;

/** Envelope-like shape for events (avoids circular dep with event-plane) */
export type EnvelopeLike = { name: string; meta: EventMeta; payload: unknown };
export type RunEvents = readonly EnvelopeLike[];

export type ContextEvents = {
  /** All events in the context across all runs */
  readonly all: readonly EnvelopeLike[];
  /** Get events for a specific run */
  byRun(runId: string): readonly EnvelopeLike[];
  /** Map of runId -> events */
  readonly map: ReadonlyMap<string, readonly EnvelopeLike[]>;
};

// Re-export Schema from effect for convenience
export { Schema as S } from 'effect';

export type AgentNetworkEventDef<
  EventName extends string,
  PayloadSchema extends S.Schema.Any,
> = {
  readonly _tag: 'AgentNetworkEventDef';
  readonly name: EventName;
  readonly payload: PayloadSchema;

  /** Decode unknown payload -> typed payload (Effect) */
  readonly decodePayload: (
    u: unknown,
  ) => Effect.Effect<S.Schema.Type<PayloadSchema>, ParseError>;

  /** Decode the full envelope (meta + payload) */
  readonly decode: (
    u: unknown,
  ) => Effect.Effect<
    { name: EventName; meta: EventMeta; payload: S.Schema.Type<PayloadSchema> },
    ParseError
  >;

  /**
   * Create an unbound event (name + payload only) for emit. Validates payload via schema.
   * Meta is injected by the runtime when the event is emitted.
   */
  readonly make: (payload: unknown) => {
    name: EventName;
    payload: S.Schema.Type<PayloadSchema>;
  };

  /**
   * Create a full envelope (meta + payload) for tests or manual trigger events.
   * Sync, throws on validation error.
   */
  readonly makeBound: (
    meta: unknown,
    payload: unknown,
  ) => {
    name: EventName;
    meta: EventMeta;
    payload: S.Schema.Type<PayloadSchema>;
  };

  /**
   * Effect version of make. Use when composing in Effect pipelines.
   */
  readonly makeEffect: (
    payload: unknown,
  ) => Effect.Effect<
    { name: EventName; payload: S.Schema.Type<PayloadSchema> },
    ParseError
  >;

  /**
   * Effect version of makeBound. Use when composing in Effect pipelines.
   */
  readonly makeBoundEffect: (
    meta: unknown,
    payload: unknown,
  ) => Effect.Effect<
    { name: EventName; meta: EventMeta; payload: S.Schema.Type<PayloadSchema> },
    ParseError
  >;

  /**
   * Type guard: returns true if `u` is a valid event of this type.
   */
  readonly is: (u: unknown) => u is {
    name: EventName;
    meta: EventMeta;
    payload: S.Schema.Type<PayloadSchema>;
  };
};

type Envelope<EventName extends string, Meta, Payload> = {
  name: EventName;
  meta: Meta;
  payload: Payload;
};

export const AgentNetworkEvent = {
  of<const EventName extends string, PS extends S.Schema.Any>(
    name: EventName,
    payload: PS,
  ): AgentNetworkEventDef<EventName, PS> {
    const decodePayload = S.decodeUnknown(payload);
    const envelopeSchema = S.Struct({
      name: S.Literal(name),
      meta: EventMetaSchema,
      payload,
    });
    const decodeEnvelope = S.decodeUnknown(envelopeSchema);

    const make = (
      payload: unknown,
    ): { name: EventName; payload: S.Schema.Type<PS> } => {
      const decoded = Effect.runSync(
        decodePayload(payload) as unknown as Effect.Effect<
          S.Schema.Type<PS>,
          ParseError
        >,
      );
      return { name, payload: decoded };
    };

    const makeBound = (
      meta: unknown,
      payload: unknown,
    ): Envelope<EventName, EventMeta, S.Schema.Type<PS>> =>
      Effect.runSync(
        decodeEnvelope({ name, meta, payload }) as unknown as Effect.Effect<
          Envelope<EventName, EventMeta, S.Schema.Type<PS>>,
          ParseError
        >,
      );

    const makeEffect = (
      payload: unknown,
    ): Effect.Effect<
      { name: EventName; payload: S.Schema.Type<PS> },
      ParseError
    > =>
      (
        decodePayload(payload) as unknown as Effect.Effect<
          S.Schema.Type<PS>,
          ParseError
        >
      ).pipe(Effect.map((p: S.Schema.Type<PS>) => ({ name, payload: p })));

    const makeBoundEffect = (
      meta: unknown,
      payload: unknown,
    ): Effect.Effect<
      Envelope<EventName, EventMeta, S.Schema.Type<PS>>,
      ParseError
    > =>
      decodeEnvelope({ name, meta, payload }) as unknown as Effect.Effect<
        Envelope<EventName, EventMeta, S.Schema.Type<PS>>,
        ParseError
      >;

    const is = S.is(envelopeSchema) as unknown as (
      u: unknown,
    ) => u is Envelope<EventName, EventMeta, S.Schema.Type<PS>>;

    return {
      _tag: 'AgentNetworkEventDef' as const,
      name,
      payload,
      decodePayload: decodePayload as unknown as AgentNetworkEventDef<
        EventName,
        PS
      >['decodePayload'],
      decode: decodeEnvelope as unknown as AgentNetworkEventDef<
        EventName,
        PS
      >['decode'],
      make,
      makeBound,
      makeEffect,
      makeBoundEffect,
      is,
    };
  },
};
