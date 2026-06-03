import type { NetworkTracer, RunSpan, RunTraceScope, TraceRunType } from '@m4trix/core/matrix';
import type { Tracer } from '../tracer.js';

function startChildRun(
  tracer: Tracer,
  type: TraceRunType,
  name: string,
  input: unknown,
  parentRunId: string,
): RunSpan {
  const runId = crypto.randomUUID();
  const started =
    type === 'llm'
      ? tracer.handleChatModelStart({}, input, runId, parentRunId, undefined, [], { name }, name)
      : tracer.handleChainStart(
          {},
          { name, input },
          runId,
          parentRunId,
          [],
          { type, name },
          type,
          name,
        );

  return {
    runId,
    end: async (output, error) => {
      await started;
      if (type === 'llm') {
        if (error) await tracer.handleLLMError(error, runId);
        else await tracer.handleLLMEnd(output, runId);
        return;
      }
      if (type === 'tool') {
        if (error) await tracer.handleToolError(error, runId);
        else await tracer.handleToolEnd(output, runId);
        return;
      }
      if (error) await tracer.handleChainError(error, runId);
      else await tracer.handleChainEnd(output, runId);
    },
  };
}

/** Adapts @m4trix/tracing Tracer to core's NetworkTracer. */
export function toM4trixTracer(tracer: Tracer): NetworkTracer {
  return {
    onRunStart: async ({ runId, contextId }) => {
      await tracer.handleChainStart({}, {}, runId, undefined, [], { projectId: contextId });
    },
    onRunEnd: async ({ runId }, error) => {
      if (error) await tracer.handleChainError(error, runId);
      else await tracer.handleChainEnd({}, runId);
      await tracer.flush();
    },
    onEventPublish: async () => {},
    onAgentInvokeStart: async ({ agentId, trigger }) => {
      const agentRunId = crypto.randomUUID();
      await tracer.handleChainStart({}, { agentId }, agentRunId, trigger.meta.runId, [], {
        agentId,
      });

      const scope: RunTraceScope = {
        runId: agentRunId,
        contextId: trigger.meta.contextId,
        startRun: (type, name, input) => startChildRun(tracer, type, name, input, agentRunId),
        flush: () => tracer.flush(),
      };
      return scope;
    },
    onAgentInvokeEnd: async (scope, error) => {
      if (error) await tracer.handleChainError(error, scope.runId);
      else await tracer.handleChainEnd({}, scope.runId);
      await tracer.flush();
    },
    flush: () => tracer.flush(),
  };
}
