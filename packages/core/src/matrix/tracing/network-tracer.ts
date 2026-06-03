import type { EventMeta } from '../agent-network/agent-network-event.js';
import type { Envelope } from '../agent-network/event-plane.js';

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

export type NetworkTracer = {
  onRunStart(meta: { runId: string; contextId: string }): Promise<void>;
  onRunEnd(meta: { runId: string; contextId: string }, error?: Error): Promise<void>;
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
  onAgentInvokeEnd(scope: RunTraceScope, error?: Error): Promise<void>;
  flush(): Promise<void>;
};

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
  onRunEnd: async ({ runId, contextId }, error) => {
    // eslint-disable-next-line no-console
    console.log(
      `[trace] run.end runId=${runId} contextId=${contextId} status=${error ? 'error' : 'ok'}`,
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
  onAgentInvokeEnd: async (scope, error) => {
    // eslint-disable-next-line no-console
    console.log(
      `[trace] agent.invoke.end runId=${scope.runId} status=${error ? 'error' : 'ok'}`,
      error ? error.message : '',
    );
  },
  flush: async () => {},
};
