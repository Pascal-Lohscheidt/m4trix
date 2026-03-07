import type { Envelope, EventPlane } from '../agent-network/event-plane';
import type { Layer, Schema as S } from 'effect';
import type { AgentNetworkEventDef } from '../agent-network/agent-network-event';
import type { ChannelName } from '../identifiers/channel-name';

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
export type AuthResult =
  | { allowed: true }
  | { allowed: false; status?: number; message?: string };

/** Channel/event selection for the exposed stream */
export type ExposeSelect = {
  /** Channel(s) to subscribe to. Plain strings are validated as kebab-case. Default: client channel or first channel. */
  channels?: ChannelName | ChannelName[] | string | string[];
  /** Event names to filter. Empty = all events. */
  events?: string[];
};

/** Unbound event shape (name + payload, no meta) - use eventDef.make(payload) to create */
export type UnboundEvent = { name: string; payload: unknown };

/** Context passed to onRequest callback */
export type OnRequestContext<T = unknown> = {
  setRunId: (id: string) => void;
  setContextId: (id: string) => void;
  /** Emit the start event. Pass { contextId, runId, event } where event is the unbound version of one of triggerEvents (e.g. MessageEvent.make(payload)). */
  emitStartEvent: (opts: {
    contextId: string;
    runId: string;
    event: UnboundEvent;
  }) => void;
  /** The raw request context */
  req: ExposeRequest;
  /** Pre-parsed request body (JSON for POST, or {} for GET) */
  payload: T;
};

/** Options for agentNetwork.expose() */
export type ExposeOptions = {
  protocol: 'sse';
  /** Called per-request. Return { allowed: false } to reject. */
  auth?: (req: ExposeRequest) => AuthResult | Promise<AuthResult>;
  /** Which channels/events to stream */
  select?: ExposeSelect;
  /** Optional: use existing EventPlane instead of creating one per request */
  plane?: EventPlane;
  /** Event definitions that can trigger a run (e.g. from AgentNetworkEvent.of). First is used for default emit. Default: "request" when omitted. */
  triggerEvents?: ReadonlyArray<AgentNetworkEventDef<string, S.Schema.Any>>;
  /** Called when a client connects, after plane is ready. Use setRunId/setContextId and emitStartEvent. */
  onRequest?: <T = unknown>(ctx: OnRequestContext<T>) => void | Promise<void>;
  /** Optional: Layer to provide when running (e.g. consoleTracerLayer for trace logging). */
  tracingLayer?: Layer.Layer<never>;
};

/** Protocol-agnostic stream source that adapters consume */
export type ExposedStream = AsyncIterable<Envelope>;

/** Factory that creates a stream for a given request. Runs the network in scope. */
export type StreamFactory = {
  (req: ExposeRequest): Promise<ExposedStream>;
  <T>(
    req: ExposeRequest,
    consumer: (stream: ExposedStream) => Promise<T>,
  ): Promise<T>;
};

/** API returned by agentNetwork.expose() - consumed by adapters */
export type ExposedAPI = {
  protocol: 'sse';
  /** Create a stream for this request. Adapter calls this when handling a request.
   * When consumer is provided, runs the consumer with the stream (scope stays open during consumption). */
  createStream: StreamFactory;
};
