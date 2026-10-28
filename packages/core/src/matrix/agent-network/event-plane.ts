import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Either,
  Exit,
  FiberId,
  type FiberRefs,
  Queue,
  type Schema as S,
  Schedule,
  Scope,
} from 'effect';
import * as Duration from 'effect/Duration';
import type { FoldSkip } from '../context/context-fold.js';
import { createFoldCache, type FoldCache } from '../context/fold-cache.js';
import { type FoldCheckpointPayload, isFoldCheckpointEvent } from '../context/fold-checkpoint.js';
import { createFoldReader, type FoldCacheEntry } from '../context/fold-reader.js';
import type { NetworkLogger } from '../logger.js';
import type { NetworkMetricHandler } from '../metrics.js';
import type { Principal } from '../principal.js';
import {
  guardNetworkTracer,
  type NetworkTracer,
  type NetworkTraceStatus,
  noopNetworkTracer,
  type RunTraceScope,
  tracerFailureLogger,
} from '../tracing/network-tracer.js';
import {
  addUsage,
  type RunUsage,
  sanitizeUsageReport,
  snapshotUsage,
  type UsageReport,
  type UsageSource,
} from '../usage.js';
import { EmitValidationError, toValidationIssues, type ValidationIssue } from '../validation.js';
import type { AgentNetwork, AnyAgent } from './agent-network.js';
import type { AgentNetworkEventDef, EventMeta } from './agent-network-event.js';
import { type ChannelName, type ConfiguredChannel, channelAcceptsEvent } from './channel.js';
import { createInMemoryTransport, type EventTransport } from './event-transport.js';
import { createEventHistory, type EventHistory, type HistoryScope, storeKeyOf } from './history.js';
import {
  AgentAbortedError,
  type AgentErrorEnvelope,
  agentFailureOutcome,
  isReservedEventName,
  isRunLifecycleEnvelope,
  limitExceededOutcome,
  NetworkStoreError,
  outcomeTraceStatus,
  type ResolvedRunLimits,
  ReservedEventNameError,
  RunLifecycleEvent,
  type RunLimitName,
  type RunLimitOptions,
  type RunOutcome,
  RunTimeoutError,
  resolveRunLimits,
  runEndEnvelope,
  serializeError,
  storeErrorOutcome,
  withRunUsage,
} from './run-lifecycle.js';
import type { AgentNetworkStore, StoredEvent } from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';
import { declaredEventDefinitions } from './wiring.js';
import {
  decodeWirePayload,
  encodePayload,
  NonJsonPayloadError,
  type NotJsonCompatibleError,
  storedFormOf,
  storedJsonOf,
  wirePayloadOf,
} from './stored-payload.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/* ─── Envelope ─── */

export type Envelope = {
  name: string;
  meta: EventMeta;
  payload: unknown;
};

export class PublishAndAwaitTimeoutError extends Error {
  readonly _tag = 'PublishAndAwaitTimeoutError';

  constructor(readonly timeout: Duration.DurationInput) {
    super(`publishAndAwait timed out after ${String(timeout)}`);
    this.name = 'PublishAndAwaitTimeoutError';
  }
}

/* ─── EventPlane ─── */

/** Identifies a run: its `runId` within a `contextId`. */
export type RunMeta = { runId: string; contextId: string };

/** Safety-net limits for a supervised run. Pass `Infinity` to disable either. */
export type RunLimits = {
  /**
   * Fail the run when it sits idle this long: no agent invocation of the run in flight or
   * queued, and no event published for it. Time spent inside an invocation never counts.
   */
  idleTimeout: Duration.DurationInput;
  /** Fail the run when it is still going after this long, stuck agents included. */
  maxDuration: Duration.DurationInput;
};

export type EventPlane = {
  /**
   * Publishes `envelope` to `channel` from outside the network (a start event, an inbound event),
   * its payload as agents receive it (decoded, e.g. from `Event.makeBound`). Fails, publishing
   * nothing, with `ReservedEventNameError` for a reserved `m4trix:` name (those are the
   * runtime's) and with `NonJsonPayloadError` for a durable event whose payload the store cannot
   * keep as JSON; the run goes on.
   */
  readonly publish: (
    channel: ChannelName,
    envelope: Envelope,
  ) => Effect.Effect<boolean, ReservedEventNameError | NonJsonPayloadError>;
  /** Like `publish`, to several channels at once. */
  readonly publishToChannels: (
    channels: readonly ConfiguredChannel[],
    envelope: Envelope,
  ) => Effect.Effect<boolean, ReservedEventNameError | NonJsonPayloadError>;
  /** Like `publishToChannels`, then waits for a reply `match` accepts. */
  readonly publishAndAwait: (
    channels: readonly ConfiguredChannel[],
    envelope: Envelope,
    match: (reply: Envelope) => boolean,
    options?: { timeout?: Duration.DurationInput },
  ) => Effect.Effect<
    Envelope,
    PublishAndAwaitTimeoutError | ReservedEventNameError | NonJsonPayloadError
  >;
  /**
   * Subscribes to the events published to `channel` from now on. With a `filter`, only events
   * it accepts are queued, so a slow reader only holds back publishers of events it wants.
   */
  readonly subscribe: (
    channel: ChannelName,
    filter?: (envelope: Envelope) => boolean,
  ) => Effect.Effect<Queue.Dequeue<Envelope>, never, Scope.Scope>;
  /**
   * The durable history of a run and its context in the plane's store, as agents read it
   * (`ctx.history`), in the namespace of `scope.principalId`: stored events, read-only, their
   * payloads encoded with their event's schema (see `StoredEvent`).
   */
  readonly history: (scope: HistoryScope) => EventHistory;
  readonly shutdown: Effect.Effect<void>;
  /**
   * Ends a run once: aborts its in-flight agent invocations, waits for them to settle, then
   * publishes the run-end lifecycle event to every channel and releases the run's state.
   * Returns `false` (and does nothing) when the run had already ended.
   */
  readonly endRun: (meta: RunMeta, outcome: RunOutcome) => Effect.Effect<boolean>;
  /** Succeeds with the run's outcome once it has ended. */
  readonly awaitRunEnd: (runId: string) => Effect.Effect<RunOutcome>;
  /**
   * The outcome of an ended run; `undefined` while the run is still going. The plane remembers
   * the most recent ended runs only (see `ENDED_RUNS_REMEMBERED`).
   */
  readonly getRunOutcome: (runId: string) => RunOutcome | undefined;
  /**
   * Applies the network's `onAgentError` policy to a failed invocation of `agentId` that was
   * handling `trigger`. Does nothing once the run has ended.
   */
  readonly reportAgentError: (
    trigger: Envelope,
    agentId: string,
    error: unknown,
  ) => Effect.Effect<void>;
  /**
   * Fails the run (`m4trix:run.failed`, kind `idle-timeout` / `max-duration`) when it exceeds
   * `limits`. Completes once the run has ended, however it ended.
   */
  readonly superviseRun: (meta: RunMeta, limits: RunLimits) => Effect.Effect<void>;
};

/* ─── Create EventPlane ─── */

/** Default bound of every subscriber queue and per-(agent, run) mailbox. */
const DEFAULT_CAPACITY = 16;

/**
 * A durable event's store write is tried this often, waiting `STORE_RETRY_BASE` and then twice as
 * long between tries, before its run fails with kind `store-error`.
 */
const STORE_WRITE_ATTEMPTS = 3;
const STORE_RETRY_BASE = Duration.millis(10);

/** Upper bound `endRun` waits for aborted invocations to finish their tracing. */
const SETTLE_TIMEOUT = Duration.seconds(5);

/**
 * How many ended runs a plane remembers after releasing their state, so that late events for
 * them are still recognised (and dropped) and `getRunOutcome` still answers.
 */
const ENDED_RUNS_REMEMBERED = 1_000;

/**
 * How many skipped events (per fold and reason) a plane remembers as reported, so a fold read
 * again from the start (cold) does not warn about them again. Beyond it, the least recently seen
 * is forgotten and may warn again.
 */
const SKIPS_REMEMBERED = 1_000;

/** The stored copy of each durable envelope a plane appended (its wire form, `wireEnvelope`). */
const storedCopies = new WeakMap<Envelope, StoredEvent>();

/** The wire form of each stored copy, made on first use. */
const wireForms = new WeakMap<StoredEvent, Envelope>();

type MailboxEntry = {
  readonly envelope: Envelope;
  /** The subscribed channel the event arrived on. */
  readonly channel: ChannelName;
  readonly transient: boolean;
};

/**
 * The events one agent has yet to handle in one run, in order. A single worker fiber drains
 * it while it is non-empty, so the agent handles one event of the run at a time.
 */
type Mailbox = {
  readonly entries: MailboxEntry[];
  /** Publishers waiting for room; woken whenever an entry leaves. */
  readonly waiting: Set<Deferred.Deferred<void>>;
  working: boolean;
};

type RunRecord = {
  readonly ended: Deferred.Deferred<RunOutcome>;
  outcome: RunOutcome | undefined;
  /** Clock time of the run's last activity: an event published, or its agents going quiet. */
  lastActivity: number;
  /** Invocations `endRun` waits for (each settles once its tracing is done). */
  readonly invocations: Set<Deferred.Deferred<void>>;
  /** Events accepted into the run's mailboxes and not yet handled (queued or in flight). */
  pending: number;
  /** Resolves when `pending` drops back to zero. */
  quiet: Deferred.Deferred<void> | undefined;
  /** Mailboxes by agent id; only agents with pending events have one. */
  readonly mailboxes: Map<string, Mailbox>;
  /** The run's limits: the plane's, plus any set for this run (`setRunLimits`). */
  limits: ResolvedRunLimits;
  /** Durable events published in the run so far, counted against `limits.maxEvents`. */
  durableEvents: number;
  /** Transient events published in the run so far (for metrics). */
  transientEvents: number;
  /** Clock time of the run's first event; unset until then. */
  startedAt: number | undefined;
  /** What the run's agents and tools reported with `reportUsage()`; unset until they do. */
  usage: RunUsage | undefined;
  /**
   * The principal the run belongs to, fixed by its first event (`meta.principalId`) or by
   * `claimRun`; `undefined` until then. Events for the run with another `principalId` are
   * refused, and its lifecycle events carry it, so they land in the run's store namespace.
   */
  owner: RunOwner | undefined;
  /**
   * Settles once the run's latest store write did. Each write starts after the one before it, so
   * a run's events reach the store in publish order whatever the store's latency.
   */
  writes: Promise<void>;
  /**
   * Effects the run's agents queued for publishing (emits, `complete()`, failures), run in order
   * by one drain fiber, so an invocation's emits stay in order and ahead of the run end it causes.
   */
  outbox: EmitQueue | undefined;
  /**
   * Settles the durable emits of the run's agents that are neither stored nor dropped yet, as
   * not stored (see `handleEntry`): called for those left in the outbox when it is dropped.
   */
  readonly unstored: Set<(stored: boolean) => void>;
};

type RunOwner = {
  /** `undefined` for an anonymous run. */
  readonly principalId: string | undefined;
  /** The full principal when the run was claimed with one (`claimRun`), e.g. from `auth`. */
  principal: Principal | undefined;
};

/** An agent started on a plane by `startAgents`. */
type AttachedAgent = {
  readonly agent: AnyAgent;
  readonly agentId: string;
  readonly listensTo: readonly string[];
  readonly subscribedTo: ReadonlySet<ChannelName>;
  readonly publishesTo: readonly ConfiguredChannel[];
  /** Caps the agent's invocations across runs; absent when uncapped. */
  readonly permits: Effect.Semaphore | undefined;
  readonly tracer: NetworkTracer;
  readonly layers: Record<string, unknown> | undefined;
  /** Scope of `startAgents`: the agent's per-run fibers live in it. */
  readonly scope: Scope.Scope;
  /**
   * Fiber refs of `startAgents` (tracing layer, log level, ...). Per-run fibers start from these
   * rather than from whichever publisher happened to fork them.
   */
  readonly fiberRefs: FiberRefs.FiberRefs;
  /** Envelopes already delivered, so one published to several of its channels arrives once. */
  readonly delivered: WeakSet<Envelope>;
  /** The agent's own definitions of the events it emits (its tools' included), by name. */
  readonly emitDefs: ReadonlyMap<string, EventDef>;
};

/** What `startAgents` and agent invocations need from a plane beyond its public members. */
type PlaneInternals = {
  readonly attach: (agent: AttachedAgent) => void;
  readonly detach: (agent: AttachedAgent) => void;
  /**
   * Queues `effect` on the run's outbox. Dropped (returns `false`) once the run's state is
   * released or the plane shut down.
   */
  readonly enqueue: (run: RunRecord, effect: Effect.Effect<void>) => boolean;
  /**
   * Publishes an event a run's agent emitted. Unlike `publishToChannels`, it never waits for room
   * in a full mailbox (see `offer`), so the run's outbox cannot stall behind one busy agent.
   * `onStored` is called once a durable event is in the store, before it is delivered.
   */
  readonly publishFromRun: (
    channels: readonly ConfiguredChannel[],
    envelope: Envelope,
    onStored: () => void,
  ) => Effect.Effect<boolean>;
  /**
   * Records a `reportUsage()` call of an invocation of `agentId` in `run`: adds it to the run's
   * usage, passes it to `tracer.onUsage`, and fails the run once it goes over a usage budget.
   */
  readonly reportUsage: (
    run: RunRecord,
    meta: RunMeta,
    report: UsageReport,
    reporter: {
      agentId: string;
      source: UsageSource | undefined;
      tracer: NetworkTracer;
      scope: RunTraceScope;
    },
  ) => void;
  /** Overrides the limits of one run; call before its first event is published. */
  readonly setRunLimits: (runId: string, limits: RunLimitOptions) => void;
  /** See `claimRun`. */
  readonly claimRun: (runId: string, principal: Principal | undefined) => boolean;
  /** Carries the plane's channel events and replies (see `EventTransport`). */
  readonly transport: EventTransport;
  readonly stats: () => EventPlaneStats;
  /** The network's logger. */
  readonly logger: Required<NetworkLogger>;
  /** The network's guarded `onMetric` handler, if any. */
  readonly metric: NetworkMetricHandler | undefined;
  /** True for events of agents' transient event definitions (never stored). */
  readonly isTransient: (name: string) => boolean;
  /** See `inspectRun`. */
  readonly runInfo: (runId: string) => RunInfo | undefined;
  /** Settles every run's unstored emits as not stored (their outboxes are gone). */
  readonly dropUnstored: () => void;
  /** Folded state behind `ctx.folds`, shared by the plane's agents (see `FoldCacheOptions`). */
  readonly foldCache: FoldCache<FoldCacheEntry>;
  /**
   * Makes the stored payload of a durable event `emitter` emits, when it emits it: encoded with
   * its definition of the event, as a frozen JSON copy. Throws `EmitValidationError`
   * (`invalid-payload`) when the payload cannot be stored.
   */
  readonly prepareEmit: (envelope: Envelope, emitter: AttachedAgent) => void;
  /** See `preparePublish`. */
  readonly preparePublished: (envelope: Envelope) => NonJsonPayloadError | undefined;
  /**
   * Reports an event a fold read left out (`FoldReaderOptions.onSkip`), once while the plane
   * remembers it (see `SKIPS_REMEMBERED`).
   */
  readonly reportSkip: (skip: FoldSkip) => void;
  /** See `wireEnvelope`. */
  readonly wire: (envelope: Envelope) => Envelope;
  /** See `fromWireEnvelope`. */
  readonly fromWire: (envelope: Envelope) => Envelope;
};

/** @internal What a plane knows about a run (see `inspectRun`). */
export type RunInfo = {
  /** The run's principal; `undefined` for an anonymous (or not yet owned) run. */
  readonly principalId: string | undefined;
  readonly outcome: RunOutcome | undefined;
};

const planeInternals = new WeakMap<EventPlane, PlaneInternals>();

const internalsOf = (plane: EventPlane): PlaneInternals => {
  const internals = planeInternals.get(plane);
  if (!internals) throw new Error('EventPlane was not created by createEventPlane');
  return internals;
};

/** @internal Sizes of a plane's per-run state. */
export type EventPlaneStats = {
  /** Runs seen and not yet ended. */
  activeRuns: number;
  /** Ended runs remembered for late events (bounded). */
  rememberedRuns: number;
  /** Per-(agent, run) mailboxes holding events. */
  mailboxes: number;
  /** Per-run outboxes with a drain fiber. */
  outboxes: number;
  /** Events queued for or being handled by agents, across active runs. */
  pendingEvents: number;
  /** Folded states in the plane's fold cache (expired ones not dropped yet included). */
  foldStates: number;
};

/** @internal For tests and diagnostics: how much per-run state `plane` holds right now. */
export const inspectEventPlane = (plane: EventPlane): EventPlaneStats => internalsOf(plane).stats();

/** @internal True when `name` is a transient event on `plane` (streamed, never stored). */
export const isTransientEvent = (plane: EventPlane, name: string): boolean =>
  internalsOf(plane).isTransient(name);

/**
 * @internal `envelope` (as `plane` delivered it) in its wire form, as events leave the network:
 * its payload encoded with its event's schema, the form the store keeps. For a durable event it
 * is its stored copy (without `channels`), so a stream sends exactly what a resumed stream replays
 * from the store. A transient event is encoded with the event's schema the network knows, its
 * Redacted values as `"<redacted>"` (see `wirePayloadOf`); one without a schema, a runtime event,
 * or a payload its schema cannot encode is sent as it is, unless the schema holds a Redacted
 * value: then all of the payload is sent as `"<redacted>"`.
 */
export const wireEnvelope = (plane: EventPlane, envelope: Envelope): Envelope =>
  internalsOf(plane).wire(envelope);

/**
 * @internal `envelope` as it arrived from outside (a proxy's `publish` / `publishInbound`), with
 * its payload decoded from the wire form with its event's schema (see `decodeWirePayload`), so
 * agents get what an emit would have given them. Without a known schema, or for a payload that is
 * neither wire data nor a value of the schema's type, it is returned as it is (and stored as
 * given: the plane's encoding of it fails).
 */
export const fromWireEnvelope = (plane: EventPlane, envelope: Envelope): Envelope =>
  internalsOf(plane).fromWire(envelope);

/**
 * @internal Makes the stored payload of `envelope`, published from outside, as `plane.publish`
 * does before it publishes anything: encoded with the schema the network knows for its name, as
 * a frozen JSON copy (see `storedFormOf`). Returns the `NonJsonPayloadError` the publish would
 * fail with, so `expose()` and proxies refuse such an event before they claim its run; `undefined`
 * when it can be stored (or is transient, never stored).
 */
export const preparePublish = (
  plane: EventPlane,
  envelope: Envelope,
): NonJsonPayloadError | undefined => internalsOf(plane).preparePublished(envelope);

/**
 * @internal The run `runId` as `plane` knows it (active, or among the recently ended);
 * `undefined` for a run it has not seen.
 */
export const inspectRun = (plane: EventPlane, runId: string): RunInfo | undefined =>
  internalsOf(plane).runInfo(runId);

/**
 * @internal Overrides the limits of the run `runId` on `plane` (e.g. per exposed request). Call it
 * before the run's start event is published.
 */
export const setRunLimits = (plane: EventPlane, runId: string, limits: RunLimitOptions): void =>
  internalsOf(plane).setRunLimits(runId, limits);

/**
 * @internal Makes `principal` (or the anonymous namespace, without one) the owner of run `runId`
 * on `plane`, before its first event is published. Returns `false` when the run already belongs
 * to someone else: its events would be refused.
 */
export const claimRun = (
  plane: EventPlane,
  runId: string,
  principal: Principal | undefined,
): boolean => internalsOf(plane).claimRun(runId, principal);

type CreateEventPlaneOptions = {
  network: AgentNetwork;
  /** Bound of each subscriber queue and each per-(agent, run) mailbox. Default 16. */
  capacity?: number;
  /** Where durable events are written before delivery. Defaults to a fresh in-memory store. */
  store?: AgentNetworkStore;
  networkTracer?: NetworkTracer;
  /** Limits of every run on the plane, over the network's (`network.getRunLimits()`). */
  limits?: RunLimitOptions;
  /**
   * Carries channel events to subscribers and replies to waiters. Defaults to the network's
   * (`transport` at setup), else a fresh in-memory transport of this plane.
   */
  transport?: EventTransport;
};

/**
 * Creates an EventPlane from an AgentNetwork. Agents started on it (`startAgents`) get one
 * bounded mailbox per run, merged across the channels they subscribe to: a full mailbox only
 * holds back publishers of that run. Other subscribers get a bounded queue each.
 */
export const createEventPlane = (options: CreateEventPlaneOptions): Effect.Effect<EventPlane> =>
  Effect.sync(() => {
    const { network, capacity = DEFAULT_CAPACITY, store = createInMemoryNetworkStore() } = options;
    const logger = network.getLogger();
    const networkTracer = guardNetworkTracer(
      options.networkTracer ?? noopNetworkTracer,
      tracerFailureLogger(logger),
    );
    const terminalEvents = network.getTerminalEvents();
    const agentErrorPolicy = network.getAgentErrorPolicy();
    const metric = network.getMetricHandler();
    const planeLimits = resolveRunLimits(network.getRunLimits(), options.limits);

    const transport = options.transport ?? network.getTransport() ?? createInMemoryTransport();
    const foldCache = createFoldCache<FoldCacheEntry>(network.getFoldCacheOptions());

    const channels = network.getChannels();
    const allChannels = [...channels.values()];
    const agents = new Set<AttachedAgent>();
    const transientEvents = new Set<string>();
    /** Queues of `subscribe`, shut down with the plane. */
    const subscriberQueues = new Set<Queue.Queue<Envelope>>();

    /* ─── Stored payloads ─── */

    let eventSchemas: ReadonlyMap<string, S.Schema.Any> | undefined;
    /** The payload schema of the event `name` as the network declares it (see `eventSchemasOf`). */
    const schemaOf = (name: string): S.Schema.Any | undefined => {
      eventSchemas ??= eventSchemasOf(network);
      return eventSchemas.get(name);
    };
    /**
     * Stored payloads made before an event is published: when an agent emits it (`prepareEmit`)
     * or when it is published from outside (`preparePublished`). A stamped copy of the envelope
     * gets its payload too (see `stampEnvelope`).
     */
    const preparedPayloads = new WeakMap<Envelope, unknown>();

    const prepareEmit = (envelope: Envelope, emitter: AttachedAgent): void => {
      // Transient events are never stored.
      if (transientEvents.has(envelope.name)) return;
      const schema = emitter.emitDefs.get(envelope.name)?.payload ?? schemaOf(envelope.name);
      const invalid = { eventName: envelope.name, agentId: emitter.agentId } as const;
      const encoded = schema
        ? encodePayload(schema, envelope.payload)
        : Either.right(envelope.payload);
      if (Either.isLeft(encoded)) {
        throw new EmitValidationError({
          ...invalid,
          reason: 'invalid-payload',
          issues: toValidationIssues(encoded.left),
        });
      }
      // Checked to decode with the same schema when a toJSON changed a value (see storedFormOf).
      const stored = storedFormOf(schema, encoded.right);
      if (Either.isLeft(stored)) {
        const { what, path } = stored.left;
        throw new EmitValidationError({
          ...invalid,
          reason: 'invalid-payload',
          issues: [notJsonIssue(stored.left)],
          notJson: { what, path },
        });
      }
      preparedPayloads.set(envelope, stored.right);
    };

    /**
     * Makes the stored payload of a durable event published from outside: encoded with the
     * schema the network knows for its name. A payload that is not a value of that type (e.g.
     * sent in its encoded form) is kept as given, for folds to decode (or skip) on read. The
     * `NonJsonPayloadError` (nothing recorded) for a payload JSON cannot hold.
     */
    const preparePublished = (envelope: Envelope): NonJsonPayloadError | undefined => {
      // Transient events are never stored.
      if (transientEvents.has(envelope.name)) return undefined;
      const schema = schemaOf(envelope.name);
      const encoded = schema ? encodePayload(schema, envelope.payload) : undefined;
      // Checked to decode again (after a toJSON) only when it was a value of the schema's type.
      const stored =
        encoded && Either.isRight(encoded)
          ? storedFormOf(schema, encoded.right)
          : storedFormOf(undefined, envelope.payload);
      if (Either.isLeft(stored)) {
        return new NonJsonPayloadError(envelope.name, stored.left.path, stored.left.what);
      }
      preparedPayloads.set(envelope, stored.right);
      return undefined;
    };

    /**
     * The stored copy of the durable event `envelope` (published to `targets`): its name, meta,
     * payload and channels, as a deep-frozen JSON copy. The payload is the one made before it was
     * published (see `preparedPayloads`). A runtime event (lifecycle, checkpoint) has no schema:
     * it is copied as it is (a checkpoint's state is encoded by its fold already). A Left for what
     * is not JSON-compatible: a runtime event's payload, or meta fields an untyped caller added
     * (typed meta is JSON: a non-finite `ts` or `depth` is stamped, see `stampEnvelope`).
     */
    const storedCopyOf = (
      envelope: Envelope,
      targets: readonly ChannelName[],
    ): Either.Either<StoredEvent, NotJsonCompatibleError> => {
      const payload = preparedPayloads.has(envelope)
        ? preparedPayloads.get(envelope)
        : envelope.payload;
      // The channels are kept with the event: a resumed stream replays only its channel's.
      const copy = { name: envelope.name, meta: envelope.meta, payload, channels: [...targets] };
      return storedJsonOf(copy) as Either.Either<StoredEvent, NotJsonCompatibleError>;
    };

    /* ─── Skipped events ─── */

    /**
     * Skips reported so far, by fold, reason and event id: the `SKIPS_REMEMBERED` least recently
     * seen are forgotten first (a `Set` keeps insertion order; a skip seen again moves to the end).
     */
    const reportedSkips = new Set<string>();

    const reportSkip = (skip: FoldSkip): void => {
      const { fold, reason, event } = skip;
      const { eventId } = event.meta;
      if (eventId !== undefined) {
        const key = JSON.stringify([fold, reason, eventId]);
        const seen = reportedSkips.delete(key);
        reportedSkips.add(key);
        if (seen) return;
        if (reportedSkips.size > SKIPS_REMEMBERED) {
          reportedSkips.delete(reportedSkips.values().next().value as string);
        }
      }
      metric?.({
        name: 'm4trix.fold.read.skipped',
        kind: 'counter',
        unit: '{event}',
        value: 1,
        attributes: { fold, reason },
      });
      const data = { fold, reason, event: event.name, eventId };
      const id = JSON.stringify(eventId);
      switch (skip.reason) {
        case 'decode':
          logger.warn(
            `[m4trix] fold "${fold}": skipped ${event.name} ${id}, its stored payload does not ` +
              "decode with the event's schema (change event schemas so stored events still " +
              `decode, e.g. make new fields optional): ${skip.error.message}`,
            data,
          );
          return;
        case 'checkpoint':
          logger.warn(
            `[m4trix] fold "${fold}": skipped checkpoint ${id}, it does not decode with the ` +
              "fold's state schema (bump the fold's version when its state changes): " +
              skip.error.message,
            data,
          );
          return;
        case 'missing-segment': {
          const { segment } = skip;
          const kind = segment.kind === undefined ? '' : `, kind ${JSON.stringify(segment.kind)}`;
          logger.warn(
            `[m4trix] fold "${fold}": ${event.name} ${id} attaches to no segment (id ` +
              `${JSON.stringify(segment.id)}${kind}); the state was left as it was (pass ` +
              "onMissing: 'ignore' to attach() when that is expected)",
            { ...data, segment },
          );
        }
      }
    };

    /* ─── Runs ─── */

    // Active runs are tracked by id from their first event on. Once a run ended and its state
    // was released, it moves to `endedRuns` so late events can still be recognised and dropped.
    const runs = new Map<string, RunRecord>();
    const endedRuns = new Map<string, RunRecord>();
    const findRun = (runId: string): RunRecord | undefined =>
      runs.get(runId) ?? endedRuns.get(runId);
    const runRecord = (runId: string): RunRecord => {
      let record = findRun(runId);
      if (!record) {
        record = {
          ended: Deferred.unsafeMake<RunOutcome>(FiberId.none),
          outcome: undefined,
          lastActivity: 0,
          invocations: new Set(),
          pending: 0,
          quiet: undefined,
          mailboxes: new Map(),
          limits: planeLimits,
          durableEvents: 0,
          transientEvents: 0,
          startedAt: undefined,
          usage: undefined,
          outbox: undefined,
          owner: undefined,
          writes: Promise.resolve(),
          unstored: new Set(),
        };
        runs.set(runId, record);
      }
      return record;
    };

    /** Drops the run's queued events and releases publishers waiting for mailbox room. */
    const closeMailboxes = (run: RunRecord): void => {
      for (const mailbox of run.mailboxes.values()) {
        run.pending -= mailbox.entries.length;
        mailbox.entries.length = 0;
        wakeWaiting(mailbox);
      }
      run.mailboxes.clear();
    };

    /** Settles the run's emits that were neither stored nor dropped yet: they never will be. */
    const dropUnstored = (run: RunRecord): void => {
      for (const settle of [...run.unstored]) settle(false);
    };

    /** Releases an ended run's state; remembers its outcome for late events. */
    const retireRun = (runId: string, run: RunRecord): Effect.Effect<void> =>
      Effect.suspend(() => {
        closeMailboxes(run);
        // Emits still queued in the outbox are dropped with it.
        dropUnstored(run);
        // Run-scoped folded state is of no use once the run is over.
        foldCache.dropRun(runId);
        const outbox = run.outbox;
        run.outbox = undefined;
        if (runs.get(runId) === run) {
          runs.delete(runId);
          endedRuns.set(runId, run);
          if (endedRuns.size > ENDED_RUNS_REMEMBERED) {
            const oldest = endedRuns.keys().next().value;
            if (oldest !== undefined) endedRuns.delete(oldest);
          }
        }
        // The drain may be running this very effect (`complete()`): it stops at its next take.
        return outbox ? Queue.shutdown(outbox) : Effect.void;
      });

    const beginWork = (run: RunRecord): void => {
      if (run.pending++ === 0) run.quiet = Deferred.unsafeMake<void>(FiberId.none);
    };

    const finishWork = (run: RunRecord): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          run.pending = Math.max(0, run.pending - 1);
          if (run.pending === 0 && run.quiet) {
            // Idle time starts once the run's agents have nothing left to do.
            run.lastActivity = Math.max(run.lastActivity, now);
            Deferred.unsafeDone(run.quiet, Exit.void);
            run.quiet = undefined;
          }
        }),
      );

    // The stamped copy of each envelope published without full meta, so publishing the same
    // envelope again (e.g. to another channel) publishes the same event.
    const stampedEnvelopes = new WeakMap<Envelope, Envelope>();

    /**
     * The envelope with `eventId`, `ts` and `depth` filled in where the publisher left them out. A
     * non-finite `ts` or `depth` (`NaN`, which JSON cannot hold) counts as left out.
     */
    const stampEnvelope = (envelope: Envelope, now: number): Envelope => {
      const { meta } = envelope;
      if (meta.eventId !== undefined && Number.isFinite(meta.ts) && Number.isFinite(meta.depth)) {
        return envelope;
      }
      let stamped = stampedEnvelopes.get(envelope);
      if (!stamped) {
        stamped = {
          ...envelope,
          meta: {
            ...meta,
            eventId: meta.eventId ?? crypto.randomUUID(),
            ts: Number.isFinite(meta.ts) ? meta.ts : now,
            depth: Number.isFinite(meta.depth) ? meta.depth : 0,
          },
        };
        stampedEnvelopes.set(envelope, stamped);
        if (preparedPayloads.has(envelope)) {
          preparedPayloads.set(stamped, preparedPayloads.get(envelope));
        }
      }
      return stamped;
    };

    const recordEvent = (envelope: Envelope, now: number): void => {
      const run = runRecord(envelope.meta.runId);
      run.lastActivity = Math.max(run.lastActivity, now);
    };

    /* ─── Agent mailboxes ─── */

    /** Runs the agent on the mailbox's events one by one; stops (and lets go) once it is empty. */
    const drainMailbox = (
      agent: AttachedAgent,
      run: RunRecord,
      mailbox: Mailbox,
    ): Effect.Effect<void> => {
      const next = Effect.sync(() => {
        const entry = mailbox.entries.shift();
        if (entry) {
          wakeWaiting(mailbox);
        } else {
          mailbox.working = false;
          if (run.mailboxes.get(agent.agentId) === mailbox) run.mailboxes.delete(agent.agentId);
        }
        return entry;
      });
      const loop = (): Effect.Effect<void> =>
        Effect.flatMap(next, (entry) =>
          entry === undefined
            ? Effect.void
            : handleEntry(plane, internals, agent, run, entry).pipe(
                Effect.ensuring(finishWork(run)),
                Effect.zipRight(Effect.suspend(loop)),
              ),
        );
      return loop();
    };

    /** Creates the run's outbox and its drain fiber in the agents' scope on first use. */
    const ensureOutbox = (run: RunRecord, agent: AttachedAgent): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (run.outbox) return Effect.void;
        const outbox = Effect.runSync(Queue.unbounded<Effect.Effect<void>>());
        run.outbox = outbox;
        return forkForAgent(agent, drainEmitQueue(outbox, logger));
      });

    /**
     * Puts `entry` into the agent's mailbox for the run. When the mailbox is full, a transient
     * event replaces the oldest buffered transient event (or is dropped when there is none); a
     * durable one waits for room when `waitForRoom` is set, and is queued beyond the bound
     * otherwise. Only the wait for room is interruptible, so a mailbox marked as worked on always
     * gets its worker.
     *
     * Events the run's own agents emit never wait: their emits are already buffered in the run's
     * outbox, and an outbox waiting on one agent's mailbox would hold back every other delivery of
     * the run, including the reply that agent may be awaiting (`emitAndAwait`). The run's event
     * cap (`maxEvents`) bounds how far a mailbox can grow that way.
     */
    const offer = (
      agent: AttachedAgent,
      run: RunRecord,
      entry: MailboxEntry,
      waitForRoom: boolean,
    ): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (run.outcome) return Effect.void;
          let mailbox = run.mailboxes.get(agent.agentId);
          if (!mailbox) {
            mailbox = { entries: [], waiting: new Set(), working: false };
            run.mailboxes.set(agent.agentId, mailbox);
          }

          if (mailbox.entries.length >= capacity && (entry.transient || waitForRoom)) {
            if (entry.transient) {
              const oldest = mailbox.entries.findIndex((e) => e.transient);
              if (oldest >= 0) {
                mailbox.entries.splice(oldest, 1);
                mailbox.entries.push(entry);
              }
              return Effect.void;
            }
            const room = Deferred.unsafeMake<void>(FiberId.none);
            mailbox.waiting.add(room);
            const waiting = mailbox.waiting;
            // Retry from scratch: the mailbox may be gone (drained or closed) by then.
            return restore(Deferred.await(room)).pipe(
              Effect.ensuring(Effect.sync(() => waiting.delete(room))),
              Effect.zipRight(offer(agent, run, entry, waitForRoom)),
            );
          }

          mailbox.entries.push(entry);
          metric?.({
            name: 'm4trix.mailbox.depth',
            kind: 'histogram',
            unit: '{event}',
            value: mailbox.entries.length,
            attributes: { agentId: agent.agentId },
          });
          beginWork(run);
          if (mailbox.working) return Effect.void;
          mailbox.working = true;
          return ensureOutbox(run, agent).pipe(
            Effect.zipRight(forkForAgent(agent, drainMailbox(agent, run, mailbox))),
          );
        }),
      );

    /** Hands the envelope to every attached agent that listens to it on one of `targets`. */
    const deliverToAgents = (
      targets: readonly ChannelName[],
      envelope: Envelope,
      waitForRoom: boolean,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        // Runtime lifecycle events never trigger agents; an ended run starts no invocations.
        if (agents.size === 0 || isReservedEventName(envelope.name)) return Effect.void;
        const run = runRecord(envelope.meta.runId);
        if (run.outcome) return Effect.void;
        const transient = transientEvents.has(envelope.name);
        const deliveries: Array<[AttachedAgent, MailboxEntry]> = [];
        for (const agent of agents) {
          if (agent.listensTo.length > 0 && !agent.listensTo.includes(envelope.name)) continue;
          const channel = targets.find((target) => agent.subscribedTo.has(target));
          if (channel === undefined || agent.delivered.has(envelope)) continue;
          agent.delivered.add(envelope);
          deliveries.push([agent, { envelope, channel, transient }]);
        }
        return Effect.forEach(
          deliveries,
          ([agent, entry]) => offer(agent, run, entry, waitForRoom),
          { discard: true },
        );
      });

    /* ─── Subscribers ─── */

    /**
     * Queues the events published to `channel` (that `filter` accepts) in a bounded queue, through
     * the transport. A full queue holds back publishers (in-memory transport).
     */
    const subscribe = (
      channel: ChannelName,
      filter?: (envelope: Envelope) => boolean,
    ): Effect.Effect<Queue.Dequeue<Envelope>, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (!channels.has(channel)) throw new Error(`Channel not found: ${channel}`);
        const queue = yield* Effect.acquireRelease(
          Queue.bounded<Envelope>(capacity).pipe(
            Effect.tap((q) => Effect.sync(() => subscriberQueues.add(q))),
          ),
          (q) =>
            Effect.sync(() => subscriberQueues.delete(q)).pipe(Effect.zipRight(Queue.shutdown(q))),
        );
        // Released before the queue shuts down, so nothing is offered to a closed queue.
        yield* transport.subscribe(channel, (envelope) =>
          Effect.suspend(() =>
            !queue.isActive() || (filter && !filter(envelope))
              ? Effect.void
              : // A queue shut down by its reader meanwhile interrupts the offer; that is not ours.
                Queue.offer(queue, envelope).pipe(Effect.catchAllCause(() => Effect.void)),
          ).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                logger.error(
                  `[m4trix] a subscriber of channel "${channel}" failed on ${envelope.name}:`,
                  Cause.pretty(cause),
                );
              }),
            ),
          ),
        );
        return queue;
      });

    /* ─── Publish ─── */

    const isTerminal = (envelope: Envelope): boolean =>
      !isReservedEventName(envelope.name) &&
      terminalEvents.some((terminal) => {
        if (terminal.name !== envelope.name) return false;
        if (!terminal.when) return true;
        try {
          return terminal.when(envelope);
        } catch (error) {
          logger.warn(`[m4trix] endsOn(${envelope.name}) predicate threw; ignoring:`, error);
          return false;
        }
      });

    /** Completes the envelope's run when it is a declared terminal event (`endsOn`). */
    const completeOnTerminal = (envelope: Envelope): Effect.Effect<void> =>
      isTerminal(envelope)
        ? endRun(envelope.meta, {
            status: 'completed',
            payload: { reason: 'terminal-event', event: envelope.name },
          }).pipe(Effect.asVoid)
        : Effect.void;

    /**
     * Counts `envelope` against its run's limits. Returns the limit it would exceed instead; such
     * an event is not published. Runtime events, and events of ended runs, are never refused.
     */
    const admit = (envelope: Envelope, now: number): RunLimitName | undefined => {
      if (isReservedEventName(envelope.name)) return undefined;
      const run = runRecord(envelope.meta.runId);
      if (run.outcome) return undefined;
      run.startedAt ??= now;
      if ((envelope.meta.depth ?? 0) > run.limits.maxDepth) return 'depth';
      // Transient events (token deltas, progress) may be numerous; loops among them still hit
      // `maxDepth`.
      if (transientEvents.has(envelope.name)) {
        run.transientEvents++;
        return undefined;
      }
      if (run.durableEvents >= run.limits.maxEvents) return 'events';
      run.durableEvents++;
      return undefined;
    };

    /**
     * True when the run of `envelope` belongs to its `principalId` (or to nobody yet, in which
     * case it now does). Runtime events are always the run's own.
     */
    const isOwnRun = (envelope: Envelope): boolean => {
      if (isReservedEventName(envelope.name)) return true;
      const run = runRecord(envelope.meta.runId);
      run.owner ??= { principalId: envelope.meta.principalId, principal: undefined };
      return run.owner.principalId === envelope.meta.principalId;
    };

    /** Fails the run of `meta` for going over `limit`. */
    const failOnLimit = (
      meta: RunMeta,
      limit: RunLimitName,
      agentId?: string,
    ): Effect.Effect<void> => {
      const { limits } = runRecord(meta.runId);
      const max = {
        depth: limits.maxDepth,
        events: limits.maxEvents,
        tokens: limits.maxTokens,
        cost: limits.maxCostUsd,
      }[limit];
      return endRun(meta, limitExceededOutcome(limit, max, agentId)).pipe(Effect.asVoid);
    };

    /**
     * Appends a durable event's stored copy (`storedCopyOf`) to the store, retrying a failed write
     * (`STORE_WRITE_ATTEMPTS`). A lifecycle event that cannot be stored is still delivered (logged
     * instead): a run that failed because its store is down must still end for its clients. Any
     * other event, a fold checkpoint included, fails its run, as does an event whose copy is not
     * JSON-compatible (logged, never retried; payloads were checked before publishing and typed
     * meta is JSON once stamped, so this is meta fields an untyped caller added).
     */
    const writeToStore = (
      envelope: Envelope,
      targets: readonly ChannelName[],
    ): Effect.Effect<void, NetworkStoreError> =>
      Effect.suspend(() => {
        const copy = storedCopyOf(envelope, targets);
        if (Either.isLeft(copy)) {
          // Nothing to retry: the event cannot be stored as it is.
          logger.error(
            `[m4trix] could not store ${envelope.name} of run ${envelope.meta.runId}: ` +
              copy.left.message,
          );
          return Effect.fail(new NetworkStoreError(envelope.name, copy.left));
        }
        const stored = copy.right;
        storedCopies.set(envelope, stored);
        let failures = 0;
        const attempt = Effect.tryPromise({
          try: () => store.append(storeKeyOf(envelope.meta), stored),
          catch: (cause) => new NetworkStoreError(envelope.name, cause),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              failures++;
              metric?.({
                name: 'm4trix.store.append.errors',
                kind: 'counter',
                unit: '{error}',
                value: 1,
                attributes: { final: failures >= STORE_WRITE_ATTEMPTS },
              });
            }),
          ),
        );
        return Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
          attempt.pipe(
            Effect.retry(
              Schedule.exponential(STORE_RETRY_BASE).pipe(
                Schedule.intersect(Schedule.recurs(STORE_WRITE_ATTEMPTS - 1)),
              ),
            ),
            Effect.onExit((exit) =>
              metric
                ? Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
                    Effect.sync(() =>
                      metric({
                        name: 'm4trix.store.append.duration_ms',
                        kind: 'histogram',
                        unit: 'ms',
                        value: endedAt - startedAt,
                        attributes: { status: Exit.isSuccess(exit) ? 'ok' : 'error' },
                      }),
                    ),
                  )
                : Effect.void,
            ),
          ),
        );
      }).pipe(
        Effect.catchAll((error) =>
          isRunLifecycleEnvelope(envelope)
            ? Effect.sync(() => {
                logger.error(
                  `[m4trix] could not store ${envelope.name} of run ${envelope.meta.runId}:`,
                  error.cause,
                );
              })
            : Effect.fail(error),
        ),
      );

    /**
     * Writes `envelope` once the earlier writes of its run are done. The write runs on its own, so
     * a publisher interrupted meanwhile neither skips it nor lets a later write overtake it.
     */
    const writeInOrder = (
      envelope: Envelope,
      targets: readonly ChannelName[],
    ): Effect.Effect<void, NetworkStoreError> =>
      Effect.suspend(() => {
        const run = runRecord(envelope.meta.runId);
        const written = run.writes.then(() =>
          Effect.runPromiseExit(writeToStore(envelope, targets)),
        );
        run.writes = written.then(() => undefined);
        return Effect.flatten(Effect.promise(() => written));
      });

    /**
     * The `targets` that accept the envelope's event (see `channel.events([...])`); each refusal is
     * logged. Agents' emits arrive pre-filtered, so this only refuses external publishes.
     */
    const acceptingChannels = (
      targets: readonly ChannelName[],
      envelope: Envelope,
    ): readonly ChannelName[] =>
      targets.filter((target) => {
        const channel = channels.get(target);
        if (!channel || channelAcceptsEvent(channel, envelope.name)) return true;
        logger.warn(
          `[m4trix] refused "${envelope.name}" on channel "${target}": the channel does not declare it (channel.events([...]))`,
          { event: envelope.name, channel: target, runId: envelope.meta.runId },
        );
        return false;
      });

    /** Publishes `published`; `onStored` runs once a durable event is stored (not when it isn't). */
    const publishTo = (
      requested: readonly ChannelName[],
      published: Envelope,
      waitForRoom: boolean,
      onStored?: () => void,
    ): Effect.Effect<boolean> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const targets = acceptingChannels(requested, published);
        // Refused by every channel it was meant for: not published at all.
        if (targets.length === 0 && requested.length > 0) return Effect.succeed(false);
        const envelope = stampEnvelope(published, now);
        if (!isOwnRun(envelope)) {
          // Keeps one principal's events out of another's run (and its history and streams).
          logger.warn(
            `[m4trix] refused ${envelope.name} for run ${envelope.meta.runId}: the run belongs to another principal`,
            { event: envelope.name, runId: envelope.meta.runId },
          );
          return Effect.succeed(false);
        }
        const exceeded = admit(envelope, now);
        if (exceeded) return failOnLimit(envelope.meta, exceeded).pipe(Effect.as(false));
        // A fold checkpoint is published to no channel: stored and traced (once, with channel
        // ''), never delivered, not even to reply waiters.
        const checkpoint = isFoldCheckpointEvent(envelope);
        const deliver = Effect.sync(() => recordEvent(envelope, now)).pipe(
          Effect.zipRight(
            Effect.forEach(
              checkpoint ? [''] : targets,
              (channel) =>
                Effect.promise(() =>
                  networkTracer.onEventPublish({
                    channel,
                    name: envelope.name,
                    meta: envelope.meta,
                    payload: checkpoint ? tracedCheckpoint(envelope) : envelope.payload,
                  }),
                ),
              { concurrency: 'unbounded', discard: true },
            ),
          ),
          Effect.zipRight(deliverToAgents(targets, envelope, waitForRoom)),
          // Subscribers of the target channels, and reply waiters (also for no channel at all).
          Effect.zipRight(checkpoint ? Effect.void : transport.publish(targets, envelope)),
          Effect.zipRight(completeOnTerminal(envelope)),
          Effect.as(true),
        );
        // Transient events are streamed and traced, never stored (so never in history).
        if (transientEvents.has(envelope.name)) return deliver;
        // A durable event is delivered once it is stored. One that could not be stored is not
        // delivered at all (history never misses an event an agent saw); its run fails.
        return writeInOrder(envelope, targets).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.sync(() => onStored?.()).pipe(Effect.zipRight(deliver)),
            onFailure: (error) =>
              endRun(envelope.meta, storeErrorOutcome(error)).pipe(Effect.as(false)),
          }),
        );
      });

    const publish = (channel: ChannelName, envelope: Envelope): Effect.Effect<boolean> =>
      publishTo([channel], envelope, true).pipe(
        Effect.withSpan('event.publish', {
          attributes: {
            'event.name': envelope.name,
            'event.payload': payloadForSpan(envelope.payload),
            channel,
            runId: envelope.meta.runId,
            contextId: envelope.meta.contextId,
          },
        }),
      );

    const publishToChannelsWith = (
      targetChannels: readonly ConfiguredChannel[],
      envelope: Envelope,
      waitForRoom: boolean,
      onStored?: () => void,
    ): Effect.Effect<boolean> =>
      publishTo(
        targetChannels.map((c) => c.name),
        envelope,
        waitForRoom,
        onStored,
      ).pipe(
        Effect.withSpan('event.publish', {
          attributes: {
            'event.name': envelope.name,
            'event.payload': payloadForSpan(envelope.payload),
            runId: envelope.meta.runId,
            contextId: envelope.meta.contextId,
          },
        }),
      );

    const publishToChannels = (
      targetChannels: readonly ConfiguredChannel[],
      envelope: Envelope,
    ): Effect.Effect<boolean> => publishToChannelsWith(targetChannels, envelope, true);

    const publishAndAwait = (
      targetChannels: readonly ConfiguredChannel[],
      envelope: Envelope,
      match: (reply: Envelope) => boolean,
      options?: { timeout?: Duration.DurationInput },
    ): Effect.Effect<Envelope, PublishAndAwaitTimeoutError> =>
      Effect.scoped(
        Effect.gen(function* () {
          // Stamped first: the transport tells the request from its replies by `eventId`.
          const request = stampEnvelope(envelope, yield* Clock.currentTimeMillis);
          const reply = yield* transport.expectReply(request, match);
          yield* publishToChannels(targetChannels, request);
          return yield* awaitReplyWithin(reply, options?.timeout);
        }),
      );

    const shutdown = Effect.suspend(() => {
      for (const run of runs.values()) dropUnstored(run);
      const queues = [...subscriberQueues];
      const outboxes = [...runs.values()].flatMap((run) => (run.outbox ? [run.outbox] : []));
      return Effect.all(
        [
          Effect.forEach(queues, Queue.shutdown, { discard: true }),
          Effect.forEach(outboxes, Queue.shutdown, { discard: true }),
        ],
        { discard: true },
      );
    });

    /* ─── Run lifecycle ─── */

    /** `meta` of a runtime event about the run, with the run's principal. */
    const ownedMeta = (meta: RunMeta): EventMeta => {
      const principalId = findRun(meta.runId)?.owner?.principalId;
      return {
        runId: meta.runId,
        contextId: meta.contextId,
        ...(principalId !== undefined && { principalId }),
      };
    };

    /** Reports the metrics of a run that just ended with `outcome`. */
    const recordRunMetrics = (run: RunRecord, outcome: RunOutcome, now: number): void => {
      if (!metric) return;
      const status = outcome.status;
      metric({
        name: 'm4trix.run.duration_ms',
        kind: 'histogram',
        unit: 'ms',
        value: Math.max(0, now - (run.startedAt ?? now)),
        attributes: { status, reason: outcomeReason(outcome) },
      });
      for (const [durability, value] of [
        ['durable', run.durableEvents],
        ['transient', run.transientEvents],
      ] as const) {
        metric({
          name: 'm4trix.run.events',
          kind: 'histogram',
          unit: '{event}',
          value,
          attributes: { status, durability },
        });
      }
      const usage = run.usage;
      if (!usage) return;
      for (const [type, value] of [
        ['input', usage.inputTokens],
        ['output', usage.outputTokens],
        ['total', usage.totalTokens],
      ] as const) {
        metric({
          name: 'm4trix.run.tokens',
          kind: 'histogram',
          unit: '{token}',
          value,
          attributes: { status, type },
        });
      }
      metric({
        name: 'm4trix.run.cost_usd',
        kind: 'histogram',
        unit: 'USD',
        value: usage.costUsd,
        attributes: { status },
      });
    };

    function endRun(meta: RunMeta, requested: RunOutcome): Effect.Effect<boolean> {
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const run = runRecord(meta.runId);
        if (run.outcome) return Effect.succeed(false);
        // The run-end event reports the usage spent until now.
        const outcome = withRunUsage(requested, run.usage && snapshotUsage(run.usage));
        run.outcome = outcome;
        recordRunMetrics(run, outcome, now);
        // Queued events will not run; publishers waiting for room go free.
        closeMailboxes(run);
        const settled = Effect.forEach([...run.invocations], (d) => Deferred.await(d), {
          concurrency: 'unbounded',
          discard: true,
        }).pipe(Effect.timeoutOption(SETTLE_TIMEOUT));
        // Resolving `ended` interrupts the run's invocations, which aborts their signals.
        return Deferred.succeed(run.ended, outcome).pipe(
          Effect.zipRight(settled),
          Effect.zipRight(publishToChannels(allChannels, runEndEnvelope(ownedMeta(meta), outcome))),
          Effect.ensuring(retireRun(meta.runId, run)),
          Effect.as(true),
        );
      });
    }

    const awaitRunEnd = (runId: string): Effect.Effect<RunOutcome> =>
      Effect.suspend(() => Deferred.await(runRecord(runId).ended));

    const getRunOutcome = (runId: string): RunOutcome | undefined => findRun(runId)?.outcome;

    const reportAgentError = (
      trigger: Envelope,
      agentId: string,
      error: unknown,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const meta = { runId: trigger.meta.runId, contextId: trigger.meta.contextId };
        if (getRunOutcome(meta.runId)) return Effect.void;
        if (agentErrorPolicy === 'continue') {
          const envelope: AgentErrorEnvelope = {
            name: RunLifecycleEvent.agentError,
            meta: ownedMeta(meta),
            payload: { agentId, trigger: trigger.name, error: serializeError(error) },
          };
          return publishToChannels(allChannels, envelope).pipe(Effect.asVoid);
        }
        return endRun(meta, agentFailureOutcome(agentId, error)).pipe(Effect.asVoid);
      });

    const superviseRun = (meta: RunMeta, limits: RunLimits): Effect.Effect<void> =>
      Effect.gen(function* () {
        const run = runRecord(meta.runId);
        const idleMillis = Duration.toMillis(limits.idleTimeout);
        const maxMillis = Duration.toMillis(limits.maxDuration);
        run.lastActivity = Math.max(run.lastActivity, yield* Clock.currentTimeMillis);

        // Idle time only accrues while the run's agents have nothing in flight or queued; the
        // timer re-arms on every event and whenever the agents go quiet again.
        const idle = Effect.gen(function* () {
          while (true) {
            if (run.quiet) {
              yield* Deferred.await(run.quiet);
              continue;
            }
            const remaining = run.lastActivity + idleMillis - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return 'idle-timeout' as const;
            yield* Effect.sleep(Duration.millis(remaining));
          }
        });
        const timedOut = yield* Effect.raceAll([
          Deferred.await(run.ended).pipe(Effect.as(undefined)),
          Number.isFinite(idleMillis) ? idle : Effect.never,
          Number.isFinite(maxMillis)
            ? Effect.sleep(Duration.millis(maxMillis)).pipe(Effect.as('max-duration' as const))
            : Effect.never,
        ]);
        if (!timedOut) return;

        const error = new RunTimeoutError(
          timedOut,
          timedOut === 'idle-timeout' ? idleMillis : maxMillis,
        );
        yield* endRun(meta, {
          status: 'failed',
          error,
          payload: { error: { ...serializeError(error), kind: timedOut } },
        });
      });

    /**
     * Publishes `envelope` from outside with `effect`, unless it is refused: a reserved name (only
     * the runtime publishes `m4trix:` events) or a payload the store cannot keep (see
     * `preparePublished`; its stored payload is made once, also when `preparePublish` checked it
     * first). A refused event is not published at all.
     */
    const external = <A, E>(
      envelope: Envelope,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | ReservedEventNameError | NonJsonPayloadError> =>
      Effect.suspend((): Effect.Effect<A, E | ReservedEventNameError | NonJsonPayloadError> => {
        if (isReservedEventName(envelope.name)) {
          return Effect.fail(new ReservedEventNameError(envelope.name));
        }
        // Made already when `preparePublish` checked it (expose, proxies): taken as it is.
        const refused = preparedPayloads.has(envelope) ? undefined : preparePublished(envelope);
        return refused ? Effect.fail(refused) : effect;
      });

    // The plane's own publishing (run ends, agent errors, agents' emits, checkpoints) uses the
    // functions above directly; the plane's members are the way in from outside.
    const plane: EventPlane = {
      publish: (channel, envelope) => external(envelope, publish(channel, envelope)),
      publishToChannels: (targetChannels, envelope) =>
        external(envelope, publishToChannels(targetChannels, envelope)),
      publishAndAwait: (targetChannels, envelope, match, options) =>
        external(envelope, publishAndAwait(targetChannels, envelope, match, options)),
      subscribe,
      history: (scope) => createEventHistory(store, scope),
      shutdown,
      endRun,
      awaitRunEnd,
      getRunOutcome,
      reportAgentError,
      superviseRun,
    };

    const internals: PlaneInternals = {
      attach: (agent) => {
        agents.add(agent);
        for (const name of agent.agent.getTransientEvents?.() ?? []) transientEvents.add(name);
      },
      detach: (agent) => {
        agents.delete(agent);
      },
      enqueue: (run, effect) => run.outbox !== undefined && Queue.unsafeOffer(run.outbox, effect),
      publishFromRun: (targetChannels, envelope, onStored) =>
        publishToChannelsWith(targetChannels, envelope, false, onStored),
      reportUsage: (run, meta, report, { agentId, source, tracer, scope }) => {
        const usage = sanitizeUsageReport(report, logger);
        run.usage = addUsage(run.usage, usage);
        void tracer.onUsage?.({
          runId: meta.runId,
          contextId: meta.contextId,
          agentId,
          ...(source?.tool && { tool: { ...source.tool } }),
          usage,
          runUsage: snapshotUsage(run.usage),
          scope,
        });
        if (run.outcome) return;
        const exceeded =
          run.usage.totalTokens > run.limits.maxTokens
            ? 'tokens'
            : run.usage.costUsd > run.limits.maxCostUsd
              ? 'cost'
              : undefined;
        // Queued like `fail()`, behind the invocation's earlier emits.
        if (exceeded) internals.enqueue(run, failOnLimit(meta, exceeded, agentId));
      },
      setRunLimits: (runId, limits) => {
        const run = runRecord(runId);
        run.limits = resolveRunLimits(run.limits, limits);
      },
      claimRun: (runId, principal) => {
        const run = runRecord(runId);
        run.owner ??= { principalId: principal?.id, principal };
        if (run.owner.principalId !== principal?.id) return false;
        run.owner.principal ??= principal;
        return true;
      },
      transport,
      logger,
      metric,
      isTransient: (name) => transientEvents.has(name),
      dropUnstored: () => {
        for (const run of runs.values()) dropUnstored(run);
      },
      foldCache,
      prepareEmit,
      preparePublished,
      reportSkip,
      wire: (envelope) => {
        const stored = storedCopies.get(envelope);
        if (stored) return wireOf(stored);
        const schema = schemaOf(envelope.name);
        if (!schema) return envelope;
        // A transient event may hold a secret (S.Redacted): it is sent as "<redacted>".
        const payload = wirePayloadOf(schema, envelope.payload);
        return payload === envelope.payload ? envelope : { ...envelope, payload };
      },
      fromWire: (envelope) => {
        const schema = schemaOf(envelope.name);
        if (!schema) return envelope;
        const decoded = decodeWirePayload(schema, envelope.payload);
        return Either.isRight(decoded) && decoded.right !== envelope.payload
          ? { ...envelope, payload: decoded.right }
          : envelope;
      },
      runInfo: (runId) => {
        const run = findRun(runId);
        return run && { principalId: run.owner?.principalId, outcome: run.outcome };
      },
      stats: () => {
        const all = [...runs.values(), ...endedRuns.values()];
        return {
          activeRuns: runs.size,
          rememberedRuns: endedRuns.size,
          mailboxes: all.reduce((n, run) => n + run.mailboxes.size, 0),
          outboxes: all.filter((run) => run.outbox !== undefined).length,
          pendingEvents: [...runs.values()].reduce((n, run) => n + run.pending, 0),
          foldStates: foldCache.size(),
        };
      },
    };
    planeInternals.set(plane, internals);
    return plane;
  });

/**
 * Forks `effect` into the agents' scope, running with the fiber refs of `startAgents`. The fork
 * may happen in an uninterruptible region (see `offer`); the forked fiber is interruptible.
 */
function forkForAgent(agent: AttachedAgent, effect: Effect.Effect<unknown>): Effect.Effect<void> {
  return Effect.forkIn(
    Effect.interruptible(Effect.setFiberRefs(agent.fiberRefs).pipe(Effect.zipRight(effect))),
    agent.scope,
  ).pipe(Effect.asVoid);
}

function wakeWaiting(mailbox: Mailbox): void {
  for (const room of mailbox.waiting) Deferred.unsafeDone(room, Exit.void);
  mailbox.waiting.clear();
}

/** The metric `reason` of an outcome: completion reason, failure kind or cancel reason. */
function outcomeReason(outcome: RunOutcome): string {
  switch (outcome.status) {
    case 'completed':
      return outcome.payload.reason;
    case 'failed':
      return outcome.payload.error.kind;
    case 'cancelled':
      return outcome.payload.reason;
  }
}

/** Waits for `reply`, failing with `PublishAndAwaitTimeoutError` after `timeout` (default 30s). */
function awaitReplyWithin(
  reply: Effect.Effect<Envelope>,
  timeout: Duration.DurationInput = '30 seconds',
): Effect.Effect<Envelope, PublishAndAwaitTimeoutError> {
  return reply.pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () => new PublishAndAwaitTimeoutError(timeout),
    }),
  );
}

/**
 * The payload schema of every event the network declares, by name (see
 * `declaredEventDefinitions`): the first definition of a name wins. The wiring check warns when a
 * name has different schemas (`event-schema-mismatch`).
 */
function eventSchemasOf(network: AgentNetwork): ReadonlyMap<string, S.Schema.Any> {
  const schemas = new Map<string, S.Schema.Any>();
  for (const { def } of declaredEventDefinitions(network)) {
    if (!schemas.has(def.name)) schemas.set(def.name, def.payload);
  }
  return schemas;
}

/** The issue of an emit whose (encoded) payload is not JSON-compatible. */
function notJsonIssue(error: NotJsonCompatibleError): ValidationIssue {
  return {
    path: error.path,
    message:
      `${error.what} is not JSON-compatible: events are stored as JSON, encoded with their ` +
      'schema; give it a schema that encodes it (e.g. S.Date, not S.DateFromSelf)',
  };
}

/** A stored event as it is sent: without its storage-only `channels`. */
function wireOf(stored: StoredEvent): Envelope {
  let wire = wireForms.get(stored);
  if (!wire) {
    const { channels: _channels, ...envelope } = stored;
    wire = envelope;
    wireForms.set(stored, wire);
  }
  return wire;
}

/** What tracers get of a fold checkpoint: which fold and read it is, not its (large) state. */
function tracedCheckpoint(envelope: Envelope): Omit<FoldCheckpointPayload, 'state'> {
  const { fold, version, through } = envelope.payload as FoldCheckpointPayload;
  return { fold, version, through };
}

/** Serialize payload for span attributes; truncate if too long */
function payloadForSpan(payload: unknown, maxLen = 500): string {
  try {
    const s = JSON.stringify(payload);
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  } catch {
    return String(payload);
  }
}

/* ─── Agent invocation ─── */

type EmitQueue = Queue.Queue<Effect.Effect<void>>;

/** Runs queued effects in order. A defect in one is logged and does not stop the drain. */
const drainEmitQueue = (queue: EmitQueue, logger: Required<NetworkLogger>): Effect.Effect<never> =>
  Effect.forever(
    Queue.take(queue).pipe(
      Effect.flatMap((effect) =>
        effect.pipe(
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.void
              : Effect.sync(() => {
                  logger.error('[m4trix] failed to publish a queued event:', Cause.pretty(cause));
                }),
          ),
        ),
      ),
    ),
  );

type InvocationResult =
  | { readonly _tag: 'returned' }
  | { readonly _tag: 'threw'; readonly error: unknown }
  | { readonly _tag: 'aborted'; readonly outcome: RunOutcome };

/**
 * Handles one mailbox entry: invokes the agent with the envelope as `triggerEvent` (within the
 * agent's concurrency cap), traces it, and applies the failure policy. The invocation races the
 * end of its run: when the run ends first it is interrupted, which aborts the agent's `signal`.
 */
function handleEntry(
  plane: EventPlane,
  internals: PlaneInternals,
  attached: AttachedAgent,
  run: RunRecord,
  entry: MailboxEntry,
): Effect.Effect<void> {
  const { agent, agentId, publishesTo, tracer: networkTracer, layers } = attached;
  const { envelope, channel } = entry;
  const meta = envelope.meta;
  const runEnded = (): boolean => run.outcome !== undefined;
  // Everything an invocation publishes goes through its run's outbox, in call order.
  const enqueue = (effect: Effect.Effect<void>): void => {
    internals.enqueue(run, effect);
  };
  // The invocation's durable emits that are neither stored nor dropped yet: its fold reads wait
  // for them (read-your-writes), each read for the ones emitted before it.
  const unstored = new Set<Promise<void>>();
  // Set once one of its emits was dropped instead of stored: no later read can include it.
  let lostEmit = false;
  // Emits that reach the outbox after the run ended are dropped on purpose.
  const publishForRun = (
    targets: readonly ConfiguredChannel[],
    fullEnvelope: Envelope,
    settle: (stored: boolean) => void,
  ): Effect.Effect<void> =>
    Effect.suspend(() =>
      runEnded()
        ? Effect.void
        : internals.publishFromRun(targets, fullEnvelope, () => settle(true)).pipe(Effect.asVoid),
    );
  /**
   * Queues `publish` (an emit of event `name`) on the run's outbox. A durable emit is tracked from
   * the call on, so a read right after it waits for it. It always settles: with `true` once
   * stored, else with `false` (refused, over a limit, the store failed, the run ended first, or the
   * outbox was dropped with the emit still in it).
   */
  const enqueueEmit = (
    name: string,
    publish: (settle: (stored: boolean) => void) => Effect.Effect<void>,
  ): void => {
    let settle = (_stored: boolean): void => {};
    if (!internals.isTransient(name)) {
      let resolve!: () => void;
      const stored = new Promise<void>((done) => {
        resolve = done;
      });
      settle = (wasStored) => {
        if (!unstored.delete(stored)) return;
        run.unstored.delete(settle);
        if (!wasStored) lostEmit = true;
        resolve();
      };
      unstored.add(stored);
      run.unstored.add(settle);
    }
    const queued = internals.enqueue(
      run,
      publish(settle).pipe(Effect.ensuring(Effect.sync(() => settle(false)))),
    );
    if (!queued) settle(false);
  };
  /**
   * Read-your-writes: resolves once the emits the invocation issued so far are settled. Rejects
   * with `AgentAbortedError` when one of its emits was dropped instead of stored; that only
   * happens once the run has ended (or the network stopped), so the read could not include it.
   */
  const awaitOwnEmits = async (): Promise<void> => {
    await Promise.all([...unstored]);
    if (lostEmit) throw new AgentAbortedError(run.outcome?.status ?? 'cancelled');
  };
  /**
   * The agent's publish channels that accept `name`. Throws `EmitValidationError` (reason
   * `channel`) when it has some and none does.
   */
  const targetsFor = (name: string): readonly ConfiguredChannel[] => {
    const targets = publishesTo.filter((channel) => channelAcceptsEvent(channel, name));
    if (targets.length === 0 && publishesTo.length > 0) {
      throw new EmitValidationError({
        eventName: name,
        agentId,
        reason: 'channel',
        allowed: publishesTo.map((channel) => channel.name),
      });
    }
    return targets;
  };
  // Everything the invocation emits is one hop further from the start than its trigger.
  const emitMeta: EventMeta = {
    runId: meta.runId,
    contextId: meta.contextId,
    ...(meta.principalId !== undefined && { principalId: meta.principalId }),
    ...(meta.correlationId !== undefined && { correlationId: meta.correlationId }),
    ...(meta.eventId !== undefined && { causationId: meta.eventId }),
    depth: (meta.depth ?? 0) + 1,
  };
  // The run's principal as it was claimed (e.g. from `auth`), else just its id.
  const principal: Principal | undefined =
    run.owner?.principal ?? (meta.principalId !== undefined ? { id: meta.principalId } : undefined);
  const abortedByRunEnd = Deferred.await(run.ended).pipe(
    Effect.flatMap((outcome) => Effect.fail(new AgentAbortedError(outcome.status))),
  );
  const history = plane.history({
    runId: meta.runId,
    contextId: meta.contextId,
    ...(meta.principalId !== undefined && { principalId: meta.principalId }),
  });
  // `ctx.folds` of the invocation: cached per context (or run) in the plane, read over `history`.
  const metric = internals.metric;
  const foldReader = createFoldReader({
    history,
    cache: {
      cache: internals.foldCache,
      scope: { ...storeKeyOf(meta), runId: meta.runId },
      runActive: () => !runEnded(),
    },
    // A read starts once the invocation's earlier emits are stored; with none pending, right away.
    beforeRead: () => (unstored.size === 0 && !lostEmit ? undefined : awaitOwnEmits()),
    // The runtime publishes a fold's checkpoint for the invocation, in order with its emits: so
    // the read after it waits for it, and it never outruns an emit made before the compaction.
    publishCheckpoint: ({ name, payload }) =>
      enqueueEmit(name, (settle) => publishForRun([], { name, meta: emitMeta, payload }, settle)),
    // Old history never breaks a read: what does not decode is left out, and reported.
    onSkip: internals.reportSkip,
    ...(metric && {
      onRead: ({ fold, start, events }) =>
        metric({
          name: 'm4trix.fold.read.events',
          kind: 'histogram',
          unit: '{event}',
          value: events,
          attributes: { fold, start },
        }),
    }),
  });
  const invokeAndTrace = Effect.gen(function* () {
    const scope = yield* Effect.promise(() =>
      networkTracer.onAgentInvokeStart({ agentId, channel, trigger: envelope }),
    );

    const invokedAt = yield* Clock.currentTimeMillis;
    const recordInvocation = (status: NetworkTraceStatus): Effect.Effect<void> =>
      internals.metric
        ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sync(() =>
              internals.metric?.({
                name: 'm4trix.agent.invocation.duration_ms',
                kind: 'histogram',
                unit: 'ms',
                value: now - invokedAt,
                attributes: { agentId, status },
              }),
            ),
          )
        : Effect.void;

    // Errors crossing the spans below come back as annotated copies; tracers and the
    // failure policy get the original.
    let thrown: { error: unknown } | undefined;
    const invoke = Effect.tryPromise({
      try: (signal) =>
        agent.invoke({
          triggerEvent: envelope,
          emit: (userEvent: { name: string; payload: unknown }) => {
            if (runEnded()) return;
            const targets = targetsFor(userEvent.name);
            const published: Envelope = {
              name: userEvent.name,
              meta: emitMeta,
              payload: userEvent.payload,
            };
            // Captured now: changing the payload after the emit changes nothing stored.
            internals.prepareEmit(published, attached);
            enqueueEmit(userEvent.name, (settle) => publishForRun(targets, published, settle));
          },
          emitAndAwait: (
            userEvent: { name: string; payload: unknown },
            match: (reply: Envelope) => boolean,
            options?: { timeout?: Duration.DurationInput },
          ) => {
            const targets = targetsFor(userEvent.name);
            const correlationId = crypto.randomUUID();
            const request: Envelope = {
              name: userEvent.name,
              // An `eventId` up front: the transport tells the request from its replies by it.
              meta: { ...emitMeta, correlationId, eventId: crypto.randomUUID() },
              payload: userEvent.payload,
            };
            internals.prepareEmit(request, attached);
            // The waiter lives until the invocation stops waiting.
            const waiting = Effect.runSync(Scope.make());
            const published = Deferred.unsafeMake<Effect.Effect<Envelope>>(FiberId.none);
            // Registered and published in order with the invocation's other emits; the timeout
            // starts then.
            enqueueEmit(userEvent.name, (settle) =>
              Scope.extend(
                internals.transport.expectReply(
                  request,
                  (candidate) => candidate.meta.correlationId === correlationId && match(candidate),
                ),
                waiting,
              ).pipe(
                Effect.tap(() => publishForRun(targets, request, settle)),
                Effect.flatMap((reply) => Deferred.succeed(published, reply)),
              ),
            );
            return Effect.runPromise(
              Effect.raceFirst(
                Deferred.await(published).pipe(
                  Effect.flatMap((reply) => awaitReplyWithin(reply, options?.timeout)),
                ),
                abortedByRunEnd,
              ).pipe(Effect.ensuring(Scope.close(waiting, Exit.void))),
            );
          },
          layers,
          history,
          foldReader,
          principal,
          tracing: scope,
          signal,
          reportUsage: (usage: UsageReport, source?: UsageSource) =>
            internals.reportUsage(run, meta, usage, {
              agentId,
              source,
              tracer: networkTracer,
              scope,
            }),
          complete: () =>
            enqueue(
              plane
                .endRun(meta, { status: 'completed', payload: { reason: 'agent', agentId } })
                .pipe(Effect.asVoid),
            ),
          fail: (error: unknown) =>
            enqueue(plane.endRun(meta, agentFailureOutcome(agentId, error)).pipe(Effect.asVoid)),
        }),
      catch: (e: unknown) => {
        thrown = { error: e };
        return e;
      },
    });

    const result: InvocationResult = yield* Effect.withSpan('agent.listen', {
      attributes: {
        agentId,
        'event.name': envelope.name,
        'event.payload': payloadForSpan(envelope.payload),
        channel,
      },
    })(
      Effect.withSpan('agent.invoke', {
        attributes: {
          agentId,
          'event.name': envelope.name,
          'event.payload': payloadForSpan(envelope.payload),
        },
      })(invoke),
    ).pipe(
      Effect.match({
        onSuccess: (): InvocationResult => ({ _tag: 'returned' }),
        onFailure: (error): InvocationResult => ({
          _tag: 'threw',
          error: thrown ? thrown.error : error,
        }),
      }),
      Effect.raceFirst(
        Deferred.await(run.ended).pipe(
          Effect.map((outcome): InvocationResult => ({ _tag: 'aborted', outcome })),
        ),
      ),
    );

    yield* recordInvocation(
      result._tag === 'returned'
        ? 'ok'
        : result._tag === 'threw'
          ? 'error'
          : outcomeTraceStatus(result.outcome),
    );
    switch (result._tag) {
      case 'returned':
        yield* Effect.promise(() =>
          networkTracer.onAgentInvokeEnd(scope, undefined, { status: 'ok' }),
        );
        return;
      case 'threw':
        yield* Effect.promise(() =>
          networkTracer.onAgentInvokeEnd(scope, result.error as Error, { status: 'error' }),
        );
        // Queued behind the invocation's emits, so a `complete()` it made still wins.
        enqueue(plane.reportAgentError(envelope, agentId, result.error));
        return;
      case 'aborted':
        // Cut short by a completed run is a normal shutdown; otherwise the span records why.
        yield* Effect.promise(() =>
          networkTracer.onAgentInvokeEnd(
            scope,
            result.outcome.status === 'completed'
              ? undefined
              : new AgentAbortedError(result.outcome.status),
            { status: outcomeTraceStatus(result.outcome) },
          ),
        );
        return;
    }
  });

  // `endRun` waits for tracked invocations, so their spans close before the run's.
  const tracked = Effect.acquireUseRelease(
    Effect.sync(() => {
      const settled = Deferred.unsafeMake<void>(FiberId.none);
      run.invocations.add(settled);
      return settled;
    }),
    () => invokeAndTrace,
    (settled) =>
      Effect.sync(() => {
        run.invocations.delete(settled);
        Deferred.unsafeDone(settled, Exit.void);
      }),
  );
  // An ended run starts no new invocations, including ones that waited for a permit.
  const guarded = Effect.suspend(() => (runEnded() ? Effect.void : tracked));

  return (attached.permits ? attached.permits.withPermits(1)(guarded) : guarded).pipe(
    // Agent failures are handled above; anything reaching here is a runtime defect.
    Effect.catchAllCause((cause: Cause.Cause<unknown>) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.void
        : Effect.sync(() => {
            internals.logger.error(`[m4trix] agent ${agentId} failed:`, Cause.pretty(cause));
          }),
    ),
  );
}

/* ─── Run Network ─── */

export type RunOptions = {
  networkTracer?: NetworkTracer;
  /** Injected dependency layer values for agent invocations */
  layers?: Record<string, unknown>;
};

/**
 * Starts every registered agent on `plane` for as long as the current scope lives. Returns once
 * all agents are attached, so an event published afterwards reaches every agent.
 *
 * Each agent gets one mailbox per run, merged across the channels it subscribes to, and handles
 * a run's events one at a time, in order; different runs proceed in parallel, up to the agent's
 * `concurrency` cap. Everything an agent invocation emits is published in order by its run's
 * outbox fiber, inside this scope.
 */
export const startAgents = (
  network: AgentNetwork,
  plane: EventPlane,
  options?: RunOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const internals = internalsOf(plane);
    const tracer = guardNetworkTracer(
      options?.networkTracer ?? noopNetworkTracer,
      tracerFailureLogger(network.getLogger()),
    );
    const scope = yield* Effect.scope;
    const fiberRefs = yield* Effect.getFiberRefs;

    for (const reg of network.getAgentRegistrations().values()) {
      const concurrency = reg.agent.getConcurrency?.() ?? Number.POSITIVE_INFINITY;
      const attached: AttachedAgent = {
        agent: reg.agent,
        agentId: reg.agent.getId(),
        listensTo: reg.agent.getListensTo?.() ?? [],
        subscribedTo: new Set(reg.subscribedTo.map((channel) => channel.name)),
        publishesTo: reg.publishesTo,
        permits: Number.isFinite(concurrency)
          ? yield* Effect.makeSemaphore(concurrency)
          : undefined,
        tracer,
        layers: options?.layers,
        scope,
        fiberRefs,
        delivered: new WeakSet(),
        emitDefs: new Map((reg.agent.getEmits?.() ?? []).map((def) => [def.name, def])),
      };
      internals.attach(attached);
      yield* Effect.addFinalizer(() => Effect.sync(() => internals.detach(attached)));
    }
    // Stopping the agents drops the runs' outboxes: emits still queued will not be stored.
    yield* Effect.addFinalizer(() => Effect.sync(internals.dropUnstored));
  });

/**
 * Runs the event plane: starts every agent (see `startAgents`) and runs until the scope ends
 * (e.g. on interrupt). Use Effect.scoped to ensure agents are properly stopped.
 */
export const run = (
  network: AgentNetwork,
  plane: EventPlane,
  options?: RunOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  startAgents(network, plane, options).pipe(Effect.zipRight(Effect.never));
