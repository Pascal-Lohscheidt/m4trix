import type { Envelope, EventPlane } from '../agent-network/event-plane.js';

export type { EventPlane };

/** Request context passed to auth and used by adapters */
export type ExposeRequest = {
  /** Web API Request (Next.js, Fetch) */
  request?: Request;
  /** Express req (when using ExpressEndpoint) */
  req?: unknown;
  /** Express res (when using ExpressEndpoint) */
  res?: unknown;
  /** Set by adapters via requestToContextId. Correlation ID between runs. */
  contextId?: string;
  /** Set by adapters via requestToRunId. Unique per run. */
  runId?: string;
};

/** Auth result: allow or deny with optional status */
export type AuthResult = { allowed: true } | { allowed: false; status?: number; message?: string };

/** Unbound event shape (name + payload, no meta) - use eventDef.make(payload) to create */
export type UnboundEvent = { name: string; payload: unknown };

/** Context passed to onRequest callback */
export type OnRequestContext<T = unknown> = {
  setRunId: (id: string) => void;
  setContextId: (id: string) => void;
  /** Emit the start event. Pass { contextId, runId, event } where event is the unbound version of one of triggerEvents (e.g. MessageEvent.make(payload)). */
  emitStartEvent: (opts: { contextId: string; runId: string; event: UnboundEvent }) => void;
  /** The raw request context */
  req: ExposeRequest;
  /** Pre-parsed request body (JSON for POST, or {} for GET) */
  payload: T;
};

/** Protocol-agnostic stream source that adapters consume */
export type ExposedStream = AsyncIterable<Envelope>;

/** Factory that creates a stream for a given request. Runs the network in scope. */
export type StreamFactory = {
  (req: ExposeRequest): Promise<ExposedStream>;
  <T>(req: ExposeRequest, consumer: (stream: ExposedStream) => Promise<T>): Promise<T>;
};

/** API returned by agentNetwork.expose() - consumed by adapters */
export type ExposedAPI = {
  protocol: 'sse';
  /** Create a stream for this request. Adapter calls this when handling a request.
   * When consumer is provided, runs the consumer with the stream (scope stays open during consumption). */
  createStream: StreamFactory;
};
