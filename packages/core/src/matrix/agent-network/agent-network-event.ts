import { Effect, Schema as S } from 'effect';
import type { ParseError } from 'effect/ParseResult';
import { isReservedEventName, RESERVED_EVENT_PREFIX } from './run-lifecycle.js';

/**
 * Standard meta carried by every event. The event plane fills in `eventId`, `ts` and `depth` when
 * an event is published without them, and sets `causationId` and `depth` on everything an agent
 * emits. All fields but `runId` and `contextId` are optional on decode.
 */
export const EventMetaSchema = S.Struct({
  runId: S.String,
  contextId: S.String,
  /** Unique id of this event. */
  eventId: S.optional(S.String),
  /** Shared by a request and its replies (`emitAndAwait`); emits inherit their trigger's. */
  correlationId: S.optional(S.String),
  /** `eventId` of the event whose handling emitted this one. Absent on start events. */
  causationId: S.optional(S.String),
  /** Publish time, in epoch milliseconds. */
  ts: S.optional(S.Number),
  /**
   * Causation depth: 0 for an event published from outside the run's agents (e.g. the start
   * event); an agent handling an event at depth `d` emits at `d + 1`. See `maxDepth`.
   */
  depth: S.optional(S.Number),
  /**
   * Id of the principal the run belongs to (from `auth`, see `AuthResult`); absent for anonymous
   * runs. It selects the store namespace of the run's history, so the runtime sets it: `expose()`
   * from `auth`, agents' emits from their trigger. Proxy publishes never take it from the event.
   */
  principalId: S.optional(S.String),
});

export type EventMeta = S.Schema.Type<typeof EventMetaSchema>;

/** Envelope-like shape for events (avoids circular dep with event-plane) */
export type EnvelopeLike = { name: string; meta: EventMeta; payload: unknown };

// Re-export Schema from effect for convenience
export { Schema as S } from 'effect';

export type AgentNetworkEventDef<EventName extends string, PayloadSchema extends S.Schema.Any> = {
  readonly _tag: 'AgentNetworkEventDef';
  readonly name: EventName;
  readonly payload: PayloadSchema;
  /**
   * Transient events (token deltas, progress ticks) may be dropped under back-pressure: when an
   * agent's mailbox for the run is full, a new transient event replaces the oldest buffered
   * transient one instead of making the publisher wait. Defaults to `false`.
   */
  readonly transient: boolean;

  /** Decode unknown payload -> typed payload (Effect) */
  readonly decodePayload: (u: unknown) => Effect.Effect<S.Schema.Type<PayloadSchema>, ParseError>;

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
  ) => Effect.Effect<{ name: EventName; payload: S.Schema.Type<PayloadSchema> }, ParseError>;

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

export type AgentNetworkEventOptions = {
  /** See {@link AgentNetworkEventDef.transient}. Defaults to `false`. */
  transient?: boolean;
};

export const AgentNetworkEvent = {
  of<const EventName extends string, PS extends S.Schema.Any>(
    name: EventName,
    payload: PS,
    options?: AgentNetworkEventOptions,
  ): AgentNetworkEventDef<EventName, PS> {
    if (isReservedEventName(name)) {
      throw new Error(
        `AgentNetworkEvent.of: "${name}" uses the reserved "${RESERVED_EVENT_PREFIX}" prefix`,
      );
    }
    const decodePayload = S.decodeUnknown(payload);
    const envelopeSchema = S.Struct({
      name: S.Literal(name),
      meta: EventMetaSchema,
      payload,
    });
    const decodeEnvelope = S.decodeUnknown(envelopeSchema);

    const make = (payload: unknown): { name: EventName; payload: S.Schema.Type<PS> } => {
      const decoded = Effect.runSync(
        decodePayload(payload) as unknown as Effect.Effect<S.Schema.Type<PS>, ParseError>,
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
    ): Effect.Effect<{ name: EventName; payload: S.Schema.Type<PS> }, ParseError> =>
      (decodePayload(payload) as unknown as Effect.Effect<S.Schema.Type<PS>, ParseError>).pipe(
        Effect.map((p: S.Schema.Type<PS>) => ({ name, payload: p })),
      );

    const makeBoundEffect = (
      meta: unknown,
      payload: unknown,
    ): Effect.Effect<Envelope<EventName, EventMeta, S.Schema.Type<PS>>, ParseError> =>
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
      transient: options?.transient ?? false,
      decodePayload: decodePayload as unknown as AgentNetworkEventDef<
        EventName,
        PS
      >['decodePayload'],
      decode: decodeEnvelope as unknown as AgentNetworkEventDef<EventName, PS>['decode'],
      make,
      makeBound,
      makeEffect,
      makeBoundEffect,
      is,
    };
  },
};
