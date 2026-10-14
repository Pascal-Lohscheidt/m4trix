import type {
  NetworkTraceEndOptions,
  NetworkTracer,
  NetworkUsageEvent,
  RunSpan,
  RunTraceScope,
  TraceRunType,
} from '@m4trix/core/matrix';
import { readLlmOutput } from '../llm-output.js';
import type { EndRunInput } from '../recorder.js';
import type { Tracer } from '../tracer.js';
import type { TraceTokens } from '../types.js';

export type M4trixTracerOptions = {
  /** Name of each network run's root run. Defaults to `agent-network`. */
  name?: string;
  projectId?: string;
  /** Record published events on the network run. Defaults to `true`. */
  captureEvents?: boolean;
};

/**
 * Adapts a {@link Tracer} to core's `NetworkTracer`. A network run becomes a trace whose session is
 * the run's context id; agent invocations nest under it, and published events are recorded on it.
 */
export function toM4trixTracer(tracer: Tracer, options: M4trixTracerOptions = {}): NetworkTracer {
  const captureEvents = options.captureEvents ?? true;

  return {
    onRunStart: async ({ runId, contextId }) => {
      tracer.startRun({
        runId,
        type: 'chain',
        name: options.name ?? 'agent-network',
        sessionId: contextId,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      });
    },
    onRunEnd: async ({ runId }, error, endOptions) => {
      await tracer.endRun(runId, endResult(error, endOptions));
      await tracer.flush();
    },
    onEventPublish: async ({ channel, name, meta, payload }) => {
      if (captureEvents) tracer.addEvent(meta.runId, name, { channel, payload });
    },
    onAgentInvokeStart: async ({ agentId, channel, trigger }) => {
      const agentRun = tracer.startRun({
        type: 'agent',
        name: agentId,
        parentRunId: trigger.meta.runId,
        input: { event: trigger.name, payload: trigger.payload },
        metadata: { agentId, event: trigger.name, ...(channel ? { channel } : {}) },
      });

      const scope: RunTraceScope = {
        runId: agentRun.runId,
        contextId: trigger.meta.contextId,
        startRun: (type, name, input) => startSpan(tracer, agentRun.runId, type, name, input),
        flush: () => tracer.flush(),
      };
      return scope;
    },
    onAgentInvokeEnd: async (scope, error, endOptions) => {
      await tracer.endRun(scope.runId, endResult(error, endOptions));
      await tracer.flush();
    },
    onUsage: (event) => recordUsage(tracer, event),
    flush: () => tracer.flush(),
  };
}

/**
 * Records a `reportUsage()` call as a finished `llm` run under the reporting invocation (or the
 * network run), so its tokens and cost count toward the trace's totals. Report usage either this
 * way or through traced LLM spans, not both, or the trace counts it twice.
 */
async function recordUsage(tracer: Tracer, event: NetworkUsageEvent): Promise<void> {
  const { usage, tool } = event;
  const run = tracer.startRun({
    type: 'llm',
    name: tool?.name ?? usage.model ?? 'usage',
    parentRunId: event.scope?.runId ?? event.runId,
    ...(usage.model ? { model: usage.model } : {}),
    metadata: {
      source: 'reportUsage',
      agentId: event.agentId,
      ...(tool ? { tool: tool.name, toolCallId: tool.toolCallId } : {}),
    },
  });
  await run.end({
    ...(usage.inputTokens !== undefined || usage.outputTokens !== undefined
      ? { tokens: usageTokens(usage) }
      : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  });
}

function usageTokens(usage: NetworkUsageEvent['usage']): TraceTokens {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens !== undefined ? { cached: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheCreation: usage.cacheWriteTokens } : {}),
  };
}

/** A cancelled run is recorded as cancelled even though core passes an error for older tracers. */
function endResult(error: Error | undefined, options?: NetworkTraceEndOptions): EndRunInput {
  if (options?.status === 'cancelled') return { cancelled: true };
  return error ? { error } : {};
}

function startSpan(
  tracer: Tracer,
  parentRunId: string,
  type: TraceRunType,
  name: string,
  input: unknown,
): RunSpan {
  const run = tracer.startRun({ type, name, input, parentRunId });
  return {
    runId: run.runId,
    end: (output, error) =>
      run.end({
        output,
        ...(error ? { error } : {}),
        // LLM spans usually end with the model's message, which carries usage and the model.
        ...(type === 'llm' ? readLlmOutput(output) : {}),
      }),
  };
}
