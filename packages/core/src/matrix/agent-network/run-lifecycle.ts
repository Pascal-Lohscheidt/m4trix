import type { NetworkTraceStatus } from '../tracing/network-tracer.js';
import type { RunUsage } from '../usage.js';
import { isEmitValidationError } from '../validation.js';
import type { EventMeta } from './agent-network-event.js';

/* ─── Reserved Event Names ─── */

/** Prefix reserved for events the runtime publishes itself. User events cannot use it. */
export const RESERVED_EVENT_PREFIX = 'm4trix:';

/**
 * Names of the events the runtime publishes about a run. `completed`, `failed` and
 * `cancelled` end a run: each is published once, after which the run's stream closes and
 * further emits for the run are dropped. `agentError` reports an agent failure under the
 * `onAgentError: 'continue'` policy; the run keeps going.
 */
export const RunLifecycleEvent = {
  completed: 'm4trix:run.completed',
  failed: 'm4trix:run.failed',
  cancelled: 'm4trix:run.cancelled',
  agentError: 'm4trix:agent.error',
} as const;

export type RunLifecycleEventName = (typeof RunLifecycleEvent)[keyof typeof RunLifecycleEvent];

export const isReservedEventName = (name: string): boolean =>
  name.startsWith(RESERVED_EVENT_PREFIX);

/**
 * An event with a reserved `m4trix:` name was published from outside the network (`plane.publish`,
 * `publishToChannels`, `publishAndAwait`, a proxy's `publish` / `publishInbound`): those names
 * belong to the runtime's own events (run lifecycle, fold checkpoints), so nothing was published.
 * Otherwise a client-chosen name could, e.g., forge a fold checkpoint that every later read
 * restores.
 */
export class ReservedEventNameError extends Error {
  /** Discriminant for `catch` / Effect error handling. */
  readonly _tag = 'ReservedEventNameError' as const;

  constructor(
    /** The refused event name. */
    readonly eventName: string,
  ) {
    super(
      `${JSON.stringify(eventName)} is reserved: names starting with "${RESERVED_EVENT_PREFIX}" ` +
        'belong to events the runtime publishes itself, so they cannot be published from outside ' +
        'the network.',
    );
    this.name = 'ReservedEventNameError';
  }
}

/* ─── Safety Net Defaults ─── */

/** Default `idleTimeout` of an exposed run: fail it after 60 seconds without events. */
export const DEFAULT_RUN_IDLE_TIMEOUT = '60 seconds';

/** Default `maxDuration` of an exposed run: fail it after 10 minutes. */
export const DEFAULT_RUN_MAX_DURATION = '10 minutes';

/**
 * Default `reconnectWindow` of an exposed run: a run whose stream dropped keeps going 30 seconds
 * for a reconnect to resume it, then is cancelled.
 */
export const DEFAULT_RECONNECT_WINDOW = '30 seconds';

/** Default `maxDepth` of a run: an event may be at most 25 hops away from its run's start. */
export const DEFAULT_RUN_MAX_DEPTH = 25;

/** Default `maxEvents` of a run: at most 1000 durable events. */
export const DEFAULT_RUN_MAX_EVENTS = 1_000;

/* ─── Run Limits ─── */

/**
 * Per-run limits. Exceeding one fails the run with `m4trix:run.failed` (kind `limit-exceeded`).
 * `Infinity` disables a limit. Set them at network setup, override them per plane
 * (`network.run()`) or per exposed run (`registerSSEStream`).
 */
export type RunLimitOptions = {
  /**
   * Max causation depth of an event (see `EventMeta.depth`): catches agents triggering each
   * other in a loop. The event that would go deeper is not delivered. Default 25.
   */
  maxDepth?: number;
  /**
   * Max durable events published in a run, the start event included. Transient events and the
   * runtime's `m4trix:*` events do not count. The event over the cap is not delivered.
   * Default 1000.
   */
  maxEvents?: number;
  /** Max `totalTokens` reported with `reportUsage()` in a run. Off (`Infinity`) by default. */
  maxTokens?: number;
  /** Max `costUsd` reported with `reportUsage()` in a run. Off (`Infinity`) by default. */
  maxCostUsd?: number;
};

/** Limits with every value set. */
export type ResolvedRunLimits = Required<RunLimitOptions>;

/** Which limit a run exceeded. */
export type RunLimitName = 'depth' | 'events' | 'tokens' | 'cost';

export const DEFAULT_RUN_LIMITS: ResolvedRunLimits = {
  maxDepth: DEFAULT_RUN_MAX_DEPTH,
  maxEvents: DEFAULT_RUN_MAX_EVENTS,
  maxTokens: Number.POSITIVE_INFINITY,
  maxCostUsd: Number.POSITIVE_INFINITY,
};

const integerLimits: ReadonlySet<keyof RunLimitOptions> = new Set(['maxDepth', 'maxEvents']);

/**
 * @internal The limits set in `options` (others left out), after checking each is a non-negative number
 * (an integer for `maxDepth` / `maxEvents`) or `Infinity`. Throws on invalid values.
 */
export function pickRunLimits(
  options: RunLimitOptions | undefined,
  where: string,
): RunLimitOptions {
  const picked: RunLimitOptions = {};
  for (const key of Object.keys(DEFAULT_RUN_LIMITS) as Array<keyof RunLimitOptions>) {
    const value = options?.[key];
    if (value === undefined) continue;
    const valid =
      typeof value === 'number' &&
      value >= 0 &&
      (value === Number.POSITIVE_INFINITY || !integerLimits.has(key) || Number.isInteger(value));
    if (!valid) {
      const expected = integerLimits.has(key)
        ? 'a non-negative integer or Infinity'
        : 'a non-negative number or Infinity';
      throw new Error(`${where}: ${key} must be ${expected}, got ${String(value)}`);
    }
    picked[key] = value;
  }
  return picked;
}

/** @internal `layers` merged left to right over the defaults; later layers win. */
export function resolveRunLimits(...layers: Array<RunLimitOptions | undefined>): ResolvedRunLimits {
  return Object.assign({}, DEFAULT_RUN_LIMITS, ...layers.map((layer) => layer ?? {}));
}

const limitOption: Record<RunLimitName, keyof RunLimitOptions> = {
  depth: 'maxDepth',
  events: 'maxEvents',
  tokens: 'maxTokens',
  cost: 'maxCostUsd',
};

/** A run went past one of its limits (`maxDepth`, `maxEvents`, `maxTokens`, `maxCostUsd`). */
export class RunLimitExceededError extends Error {
  readonly _tag = 'RunLimitExceededError';

  constructor(
    readonly limit: RunLimitName,
    readonly max: number,
  ) {
    super(`Run exceeded its ${limitOption[limit]} limit of ${max}`);
    this.name = 'RunLimitExceededError';
  }
}

/* ─── Payloads ─── */

/**
 * Why a run failed. Timeouts and exceeded limits are failures with their own kind rather than a
 * separate event. `invalid-emit`: an agent (or one of its tools) emitted an event it does not
 * declare, with a payload its schema rejects, or to channels that do not accept it
 * (`EmitValidationError`). `run-unavailable`: only on a resumed SSE stream (never stored), for a
 * run this server neither runs nor has a run-end event of (see `RunUnavailableError`).
 * `stream-error`: only on an SSE stream (never stored) the server failed to keep writing; the
 * run itself may have gone on (see `streamFailedEnvelope`).
 */
export type RunErrorKind =
  | 'agent-error'
  | 'idle-timeout'
  | 'max-duration'
  | 'limit-exceeded'
  | 'store-error'
  | 'invalid-emit'
  | 'run-unavailable'
  | 'stream-error';

/**
 * Client-safe error description: never carries a stack trace or the original error object. For
 * `kind: 'limit-exceeded'` it names the exceeded `limit` and its configured `max`; for
 * `kind: 'invalid-emit'` the refused `event` (never its payload).
 */
export type SerializedRunError =
  | {
      name: string;
      message: string;
      kind: Exclude<RunErrorKind, 'limit-exceeded' | 'invalid-emit'>;
    }
  | {
      name: string;
      message: string;
      kind: 'invalid-emit';
      /** Name of the event that was refused. */
      event: string;
    }
  | {
      name: string;
      message: string;
      kind: 'limit-exceeded';
      limit: RunLimitName;
      max: number;
    };

/** Present on every run-end payload once some agent or tool reported usage in the run. */
export type RunEndUsage = {
  /** What the run's agents and tools reported with `reportUsage()`. */
  usage?: RunUsage;
};

export type RunCompletedPayload = (
  | { reason: 'terminal-event'; event: string }
  | { reason: 'agent'; agentId: string }
) &
  RunEndUsage;

export type RunFailedPayload = {
  error: SerializedRunError;
  /** The agent that failed, called `fail()` or went over a usage budget; absent otherwise. */
  agentId?: string;
} & RunEndUsage;

export type RunCancelledPayload = {
  /** `client-abort`: the request signal aborted. `stream-closed`: the consumer stopped reading. */
  reason: 'client-abort' | 'stream-closed';
} & RunEndUsage;

export type AgentErrorPayload = {
  agentId: string;
  /** Name of the event the agent was handling. */
  trigger: string;
  error: { name: string; message: string };
};

/* ─── Envelopes ─── */

export type RunCompletedEnvelope = {
  name: typeof RunLifecycleEvent.completed;
  meta: EventMeta;
  payload: RunCompletedPayload;
};

export type RunFailedEnvelope = {
  name: typeof RunLifecycleEvent.failed;
  meta: EventMeta;
  payload: RunFailedPayload;
};

export type RunCancelledEnvelope = {
  name: typeof RunLifecycleEvent.cancelled;
  meta: EventMeta;
  payload: RunCancelledPayload;
};

export type AgentErrorEnvelope = {
  name: typeof RunLifecycleEvent.agentError;
  meta: EventMeta;
  payload: AgentErrorPayload;
};

/** The envelope that ends a run: exactly one per run. */
export type RunEndEnvelope = RunCompletedEnvelope | RunFailedEnvelope | RunCancelledEnvelope;

/** Any event the runtime publishes about a run. */
export type RunLifecycleEnvelope = RunEndEnvelope | AgentErrorEnvelope;

const runEndNames: ReadonlySet<string> = new Set([
  RunLifecycleEvent.completed,
  RunLifecycleEvent.failed,
  RunLifecycleEvent.cancelled,
]);

/** True for `m4trix:run.completed`, `m4trix:run.failed` and `m4trix:run.cancelled`. */
export function isRunEndEnvelope(envelope: { name: string }): envelope is RunEndEnvelope {
  return runEndNames.has(envelope.name);
}

/** True for every runtime lifecycle event, including `m4trix:agent.error`. */
export function isRunLifecycleEnvelope(envelope: {
  name: string;
}): envelope is RunLifecycleEnvelope {
  return isRunEndEnvelope(envelope) || envelope.name === RunLifecycleEvent.agentError;
}

/* ─── Outcomes ─── */

/** How a run ended. `failed` keeps the original error for tracers; only the payload reaches clients. */
export type RunOutcome =
  | { status: 'completed'; payload: RunCompletedPayload }
  | { status: 'failed'; payload: RunFailedPayload; error: unknown }
  | { status: 'cancelled'; payload: RunCancelledPayload };

/** A run went without events for `idleTimeout`, or ran longer than `maxDuration`. */
export class RunTimeoutError extends Error {
  readonly _tag = 'RunTimeoutError';

  constructor(
    readonly kind: 'idle-timeout' | 'max-duration',
    readonly timeoutMillis: number,
  ) {
    super(
      kind === 'idle-timeout'
        ? `Run received no events for ${timeoutMillis}ms`
        : `Run exceeded its maximum duration of ${timeoutMillis}ms`,
    );
    this.name = 'RunTimeoutError';
  }
}

/**
 * A durable event of the run could not be written to the network store, even after retries. Its
 * message is client-safe; `cause` (the store's own error) only reaches tracers.
 */
export class NetworkStoreError extends Error {
  readonly _tag = 'NetworkStoreError';

  constructor(
    readonly eventName: string,
    readonly cause: unknown,
  ) {
    super(`Could not write event "${eventName}" to the network store`);
    this.name = 'NetworkStoreError';
  }
}

/**
 * A resumed SSE stream's run is not running on this server, and its history has no run-end event:
 * it runs on another instance, or its server stopped before it ended. Sent to that stream only
 * (as `m4trix:run.failed`, kind `run-unavailable`, without an SSE id); never stored.
 */
export class RunUnavailableError extends Error {
  readonly _tag = 'RunUnavailableError';

  constructor() {
    super('The run is not running on this server and has no run-end event in its history');
    this.name = 'RunUnavailableError';
  }
}

/** @internal The run-end event of a resumed stream whose run is unavailable here. */
export function runUnavailableEnvelope(meta: EventMeta): RunFailedEnvelope {
  return runEndEnvelope(meta, {
    status: 'failed',
    error: new RunUnavailableError(),
    payload: { error: { ...serializeError(new RunUnavailableError()), kind: 'run-unavailable' } },
  }) as RunFailedEnvelope;
}

/**
 * @internal The last event of an SSE stream the server failed to keep writing: client-safe, never
 * stored, the cause stays in the server's log.
 */
export function streamFailedEnvelope(meta: {
  runId: string;
  contextId: string;
}): RunFailedEnvelope {
  return {
    name: RunLifecycleEvent.failed,
    meta: { runId: meta.runId, contextId: meta.contextId },
    payload: {
      error: { name: 'StreamError', message: 'The event stream failed', kind: 'stream-error' },
    },
  };
}

/** Reported to tracers when a run is cancelled, so cancelled runs don't look successful. */
export class RunCancelledError extends Error {
  readonly _tag = 'RunCancelledError';

  constructor(readonly reason: RunCancelledPayload['reason']) {
    super(`Run cancelled (${reason})`);
    this.name = 'RunCancelledError';
  }
}

/** Reported to tracers for an agent invocation cut short because its run ended. */
export class AgentAbortedError extends Error {
  readonly _tag = 'AgentAbortedError';

  constructor(readonly runStatus: RunOutcome['status']) {
    super(`Agent invocation aborted: run ${runStatus}`);
    this.name = 'AgentAbortedError';
  }
}

/** Name and message only: stacks, causes and custom fields stay on the server. */
export function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message };
  }
  return { name: 'Error', message: typeof error === 'string' ? error : String(error) };
}

/** The error a tracer's `onRunEnd` receives for an outcome; `undefined` for completed runs. */
export function outcomeError(outcome: RunOutcome | undefined): Error | undefined {
  if (!outcome || outcome.status === 'completed') return undefined;
  if (outcome.status === 'cancelled') return new RunCancelledError(outcome.payload.reason);
  const { error } = outcome;
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The tracer status of a run that ended with `outcome`, or of an invocation that run's end cut
 * short. A run without an outcome (never started, or still going) traces as `ok`.
 */
export function outcomeTraceStatus(outcome: RunOutcome | undefined): NetworkTraceStatus {
  switch (outcome?.status) {
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'ok';
  }
}

/** @internal `outcome` with the run's usage on its payload; unchanged when nothing was reported. */
export function withRunUsage(outcome: RunOutcome, usage: RunUsage | undefined): RunOutcome {
  if (!usage) return outcome;
  switch (outcome.status) {
    case 'completed':
      return { ...outcome, payload: { ...outcome.payload, usage } };
    case 'failed':
      return { ...outcome, payload: { ...outcome.payload, usage } };
    case 'cancelled':
      return { ...outcome, payload: { ...outcome.payload, usage } };
  }
}

/** @internal The outcome of a run that went past `limit`. */
export function limitExceededOutcome(
  limit: RunLimitName,
  max: number,
  agentId?: string,
): RunOutcome {
  const error = new RunLimitExceededError(limit, max);
  return {
    status: 'failed',
    error,
    payload: {
      error: { ...serializeError(error), kind: 'limit-exceeded', limit, max },
      ...(agentId !== undefined && { agentId }),
    },
  };
}

/**
 * @internal The outcome of a run failed by `agentId` with `error` (thrown, or passed to `fail()`):
 * kind `invalid-emit` for an `EmitValidationError`, `agent-error` otherwise.
 */
export function agentFailureOutcome(agentId: string, error: unknown): RunOutcome {
  return { status: 'failed', error, payload: { agentId, error: serializeAgentError(error) } };
}

/** @internal The client-safe form of an agent failure (see `agentFailureOutcome`). */
export function serializeAgentError(error: unknown): SerializedRunError {
  if (isEmitValidationError(error)) {
    return { ...serializeError(error), kind: 'invalid-emit', event: error.eventName };
  }
  return { ...serializeError(error), kind: 'agent-error' };
}

/** @internal The outcome of a run whose event could not be stored. */
export function storeErrorOutcome(error: NetworkStoreError): RunOutcome {
  return {
    status: 'failed',
    error,
    payload: { error: { ...serializeError(error), kind: 'store-error' } },
  };
}

export function runEndEnvelope(meta: EventMeta, outcome: RunOutcome): RunEndEnvelope {
  const runMeta: EventMeta = {
    runId: meta.runId,
    contextId: meta.contextId,
    ...(meta.principalId !== undefined && { principalId: meta.principalId }),
  };
  switch (outcome.status) {
    case 'completed':
      return { name: RunLifecycleEvent.completed, meta: runMeta, payload: outcome.payload };
    case 'failed':
      return { name: RunLifecycleEvent.failed, meta: runMeta, payload: outcome.payload };
    case 'cancelled':
      return { name: RunLifecycleEvent.cancelled, meta: runMeta, payload: outcome.payload };
  }
}

/* ─── Agent Error Policy ─── */

/**
 * What a network does when an agent throws (or rejects).
 * - `'fail'`: end the run with `m4trix:run.failed` and abort its other in-flight agents.
 * - `'continue'`: publish `m4trix:agent.error` and keep the run going.
 */
export type AgentErrorPolicy = 'fail' | 'continue';
