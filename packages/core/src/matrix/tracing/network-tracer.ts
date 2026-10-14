import type { EventMeta } from '../agent-network/agent-network-event.js';
import type { Envelope } from '../agent-network/event-plane.js';
import { consoleNetworkLogger, type NetworkLogger } from '../logger.js';
import type { RunUsage, UsageReport } from '../usage.js';

export type TraceRunType = 'chain' | 'llm' | 'tool' | 'agent';

export type RunSpan = {
  runId: string;
  end(output?: unknown, error?: Error): Promise<void>;
};

export type RunTraceScope = {
  runId: string;
  contextId: string;
  startRun(type: TraceRunType, name: string, input?: unknown): RunSpan;
  flush(): Promise<void>;
};

/**
 * How a traced run or agent invocation ended. `cancelled` is a client abort or a stream nobody
 * reads (or an invocation aborted because of one): not a failure, but not a success either.
 */
export type NetworkTraceStatus = 'ok' | 'error' | 'cancelled';

/**
 * Passed to `onRunEnd` / `onAgentInvokeEnd`. The runtime always passes it; tracers written
 * before it existed can ignore it. For `cancelled`, `error` is still set (a `RunCancelledError` /
 * `AgentAbortedError`) so such tracers keep flagging cancelled runs instead of reporting success;
 * tracers that read `status` should check it first.
 */
export type NetworkTraceEndOptions = { status: NetworkTraceStatus };

/** Passed to `onUsage` for every `reportUsage()` call of an agent or tool. */
export type NetworkUsageEvent = {
  runId: string;
  contextId: string;
  /** The agent whose invocation reported it (directly or through a tool). */
  agentId: string;
  /** Set when a tool reported it. */
  tool?: { name: string; toolCallId: string };
  /** The report, without fields that were invalid. */
  usage: UsageReport;
  /** The run's usage so far, this report included. */
  runUsage: RunUsage;
  /** The trace scope `onAgentInvokeStart` returned for the reporting invocation. */
  scope?: RunTraceScope;
};

export type NetworkTracer = {
  onRunStart(meta: { runId: string; contextId: string }): Promise<void>;
  onRunEnd(
    meta: { runId: string; contextId: string },
    error?: Error,
    options?: NetworkTraceEndOptions,
  ): Promise<void>;
  onEventPublish(event: {
    channel: string;
    name: string;
    meta: EventMeta;
    payload: unknown;
  }): Promise<void>;
  onAgentInvokeStart(ctx: {
    agentId: string;
    channel?: string;
    trigger: Envelope;
  }): Promise<RunTraceScope>;
  onAgentInvokeEnd(
    scope: RunTraceScope,
    error?: Error,
    options?: NetworkTraceEndOptions,
  ): Promise<void>;
  /** Usage an agent or tool reported with `reportUsage()`. Optional. */
  onUsage?(event: NetworkUsageEvent): Promise<void>;
  flush(): Promise<void>;
};

/** The status of an end hook call, for tracers that may be called without `options`. */
export function traceEndStatus(
  error?: Error,
  options?: NetworkTraceEndOptions,
): NetworkTraceStatus {
  return options?.status ?? (error ? 'error' : 'ok');
}

function payloadForLog(payload: unknown, maxLen = 120): string {
  try {
    const s = JSON.stringify(payload);
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  } catch {
    return String(payload);
  }
}

export function noopRunTraceScope(meta?: { runId?: string; contextId?: string }): RunTraceScope {
  const runId = meta?.runId ?? crypto.randomUUID();
  const contextId = meta?.contextId ?? crypto.randomUUID();
  return {
    runId,
    contextId,
    startRun: () => ({
      runId: crypto.randomUUID(),
      end: async () => {},
    }),
    flush: async () => {},
  };
}

export const noopNetworkTracer: NetworkTracer = {
  onRunStart: async () => {},
  onRunEnd: async () => {},
  onEventPublish: async () => {},
  onAgentInvokeStart: async ({ trigger }) => noopRunTraceScope(trigger.meta),
  onAgentInvokeEnd: async () => {},
  flush: async () => {},
};

export const consoleNetworkTracer: NetworkTracer = {
  onRunStart: async ({ runId, contextId }) => {
    // eslint-disable-next-line no-console
    console.log(`[trace] run.start runId=${runId} contextId=${contextId}`);
  },
  onRunEnd: async ({ runId, contextId }, error, options) => {
    // eslint-disable-next-line no-console
    console.log(
      `[trace] run.end runId=${runId} contextId=${contextId} status=${traceEndStatus(error, options)}`,
      error ? error.message : '',
    );
  },
  onEventPublish: async ({ channel, name, meta, payload }) => {
    // eslint-disable-next-line no-console
    console.log(
      `[trace] event.publish channel=${channel} name=${name} runId=${meta.runId}`,
      payloadForLog(payload),
    );
  },
  onAgentInvokeStart: async ({ agentId, channel, trigger }) => {
    // eslint-disable-next-line no-console
    console.log(
      `[trace] agent.invoke.start agentId=${agentId} channel=${channel ?? '-'} event=${trigger.name}`,
    );
    return noopRunTraceScope(trigger.meta);
  },
  onAgentInvokeEnd: async (scope, error, options) => {
    // eslint-disable-next-line no-console
    console.log(
      `[trace] agent.invoke.end runId=${scope.runId} status=${traceEndStatus(error, options)}`,
      error ? error.message : '',
    );
  },
  onUsage: async ({ runId, agentId, tool, usage }) => {
    // eslint-disable-next-line no-console
    console.log(
      `[trace] usage runId=${runId} agentId=${agentId}${tool ? ` tool=${tool.name}` : ''}`,
      payloadForLog(usage),
    );
  },
  flush: async () => {},
};

const GUARDED = Symbol.for('m4trix/GuardedNetworkTracer');
/** The scope each guarded scope wraps, so the tracer gets its own scope back at invoke end. */
const originalScopes = new WeakMap<RunTraceScope, RunTraceScope>();
/** Stand-in scopes handed out when `onAgentInvokeStart` failed; the tracer never saw them. */
const fallbackScopes = new WeakSet<RunTraceScope>();

/** Receives failures of a guarded tracer's hooks. */
export type NetworkTracerErrorHandler = (error: unknown, hook: string) => void;

/** Reports tracer hook failures as warnings to `logger`. */
export function tracerFailureLogger(
  logger: Pick<NetworkLogger, 'warn'>,
): NetworkTracerErrorHandler {
  return (error, hook) => {
    logger.warn(`[m4trix] network tracer ${hook} failed; continuing without it:`, error);
  };
}

const warnTracerFailure = tracerFailureLogger(consoleNetworkLogger);

/**
 * Wraps a tracer so none of its hooks can fail the network: errors (thrown or rejected) are
 * reported to `onError` and the network carries on as if tracing were off for that call.
 * Wrapping an already guarded tracer returns it unchanged.
 */
export function guardNetworkTracer(
  tracer: NetworkTracer,
  onError: NetworkTracerErrorHandler = warnTracerFailure,
): NetworkTracer {
  if ((tracer as { [GUARDED]?: true })[GUARDED]) return tracer;

  const report = (error: unknown, hook: string): void => {
    try {
      onError(error, hook);
    } catch {
      // A failing error handler must not fail the network either.
    }
  };
  const attempt = async <T>(hook: string, call: () => Promise<T>, fallback: () => T) => {
    try {
      return await call();
    } catch (error) {
      report(error, hook);
      return fallback();
    }
  };
  const nothing = (): void => undefined;

  // Inherit from the tracer's scope rather than copying it, so getters and extra members keep
  // working; only the two methods are overridden.
  const guardScope = (scope: RunTraceScope): RunTraceScope => {
    const startRun: RunTraceScope['startRun'] = (type, name, input) => {
      try {
        const span = scope.startRun(type, name, input);
        return {
          runId: span.runId,
          end: (output, error) => attempt('span.end', () => span.end(output, error), nothing),
        };
      } catch (error) {
        report(error, 'scope.startRun');
        return { runId: crypto.randomUUID(), end: async () => {} };
      }
    };
    const flush = () => attempt('scope.flush', () => scope.flush(), nothing);
    const guardedScope = Object.create(scope, {
      startRun: { value: startRun, enumerable: true },
      flush: { value: flush, enumerable: true },
    }) as RunTraceScope;
    originalScopes.set(guardedScope, scope);
    return guardedScope;
  };
  const fallbackScope = (ctx: Parameters<NetworkTracer['onAgentInvokeStart']>[0]) => {
    const scope = noopRunTraceScope({ contextId: ctx.trigger.meta.contextId });
    fallbackScopes.add(scope);
    return scope;
  };

  const guarded: NetworkTracer & { [GUARDED]: true } = {
    [GUARDED]: true,
    onRunStart: (meta) => attempt('onRunStart', () => tracer.onRunStart(meta), nothing),
    onRunEnd: (meta, error, options) =>
      attempt('onRunEnd', () => tracer.onRunEnd(meta, error, options), nothing),
    onEventPublish: (event) =>
      attempt('onEventPublish', () => tracer.onEventPublish(event), nothing),
    onAgentInvokeStart: (ctx) =>
      attempt(
        'onAgentInvokeStart',
        async () => guardScope(await tracer.onAgentInvokeStart(ctx)),
        () => fallbackScope(ctx),
      ),
    onAgentInvokeEnd: async (scope, error, options) => {
      // The tracer never started this invocation; ending it would end some other run.
      if (fallbackScopes.has(scope)) return;
      const original = originalScopes.get(scope) ?? scope;
      await attempt(
        'onAgentInvokeEnd',
        () => tracer.onAgentInvokeEnd(original, error, options),
        nothing,
      );
    },
    onUsage: async ({ scope, ...event }) => {
      if (!tracer.onUsage) return;
      // Hand the tracer its own scope back; it never saw a fallback scope.
      const original =
        scope && !fallbackScopes.has(scope) ? (originalScopes.get(scope) ?? scope) : undefined;
      await attempt(
        'onUsage',
        () =>
          tracer.onUsage?.({ ...event, ...(original && { scope: original }) }) ?? Promise.resolve(),
        nothing,
      );
    },
    flush: () => attempt('flush', () => tracer.flush(), nothing),
  };
  return guarded;
}
