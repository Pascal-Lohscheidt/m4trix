import type { Envelope, EventPlane, RunLimits, RunMeta } from '../agent-network/event-plane.js';
import type { NetworkLogger } from '../logger.js';
import type { Principal } from '../principal.js';

export type { EventPlane, RunLimits, RunMeta };

/** Request context passed to auth and used by adapters */
export type ExposeRequest = {
  /** Web API Request (Next.js, Fetch) */
  request?: Request;
  /** Express req (when using ExpressEndpoint) */
  req?: unknown;
  /** Express res (when using ExpressEndpoint) */
  res?: unknown;
  /**
   * Set by adapters via requestToContextId. Correlation ID between runs. Client-supplied: history
   * is looked up under it only within the request's principal namespace (see `AuthResult`).
   */
  contextId?: string;
  /** Set by adapters via requestToRunId. Unique per run. */
  runId?: string;
  /**
   * The SSE id a reconnecting client resumes after (`Last-Event-ID`). Adapters set it; without
   * it `expose()` reads the `Last-Event-ID` header or `?lastEventId=` of `request`. A request
   * with one resumes its run instead of starting one (see `ExposedStream.idOf`).
   */
  lastEventId?: string;
};

/**
 * Auth result: allow (optionally naming the principal the request acts for) or deny with an
 * optional status.
 *
 * The principal's `id` namespaces history: a run only reads events stored under its principal,
 * whatever `contextId` the client sends. Requests allowed without a principal (and every request
 * when no `auth` is configured) share one anonymous namespace, where any client that knows a
 * `contextId` reads that context's history; return a principal whenever requests carry identity.
 */
export type AuthResult =
  | { allowed: true; principal?: Principal }
  | { allowed: false; status?: number; message?: string };

/** Unbound event shape (name + payload, no meta) - use eventDef.make(payload) to create */
export type UnboundEvent = { name: string; payload: unknown };

/** Context passed to onRequest callback */
export type OnRequestContext<T = unknown> = {
  setRunId: (id: string) => void;
  setContextId: (id: string) => void;
  /**
   * Emit the start event. Pass { contextId, runId, event } where event is the unbound version of
   * one of triggerEvents (e.g. MessageEvent.make(payload)). An event the network knows (a trigger
   * event, or one its agents listen to or emit) is validated and published decoded; an invalid one
   * throws `ExposeValidationError` (a 400), so let it propagate out of `onRequest`.
   */
  emitStartEvent: (opts: { contextId: string; runId: string; event: UnboundEvent }) => void;
  /** The raw request context */
  req: ExposeRequest;
  /**
   * The principal `auth` returned; `undefined` for anonymous requests. `emitStartEvent` stamps it
   * on the start event, so the run and its history belong to it.
   */
  principal: Principal | undefined;
  /**
   * Pre-parsed request payload: the JSON body of a POST, the `?payload=` of a GET (URL-encoded
   * JSON), else `{}`. Malformed JSON never gets here (400).
   */
  payload: T;
};

/** Protocol-agnostic stream source that adapters consume */
export type ExposedStream = AsyncIterable<Envelope> & {
  /**
   * The SSE id of `envelope`: its resume position (`<contextId>/<runId>/<eventId>`), sent as
   * `id:` so a reconnect can resume after it (`Last-Event-ID`). `undefined` for transient events,
   * which are never replayed. Absent on streams that do not support resuming.
   */
  readonly idOf?: (envelope: Envelope) => string | undefined;
  /**
   * The resume position before the stream's first event (its run's start event), for a stream
   * that started a run. Adapters send it first (`id:` without data), so a reconnect before any
   * event resumes the run instead of starting another.
   */
  readonly startId?: string;
};

/** Factory that creates a stream for a given request. Runs the network in scope. */
export type StreamFactory = {
  (req: ExposeRequest): Promise<ExposedStream>;
  <T>(req: ExposeRequest, consumer: (stream: ExposedStream) => Promise<T>): Promise<T>;
};

/** API returned by agentNetwork.expose() - consumed by adapters */
export type ExposedAPI = {
  protocol: 'sse';
  /** The network's logger; adapters log stream failures to it unless given their own. */
  logger?: NetworkLogger;
  /** Create a stream for this request. Adapter calls this when handling a request.
   * When consumer is provided, runs the consumer with the stream (scope stays open during consumption). */
  createStream: StreamFactory;
};
