import type { RunTraceScope } from '@m4trix/core/matrix';

import { tracer } from '../../tracing/setup.js';

/** LangChain config that records the agent's LangChain runs under its m4trix invoke span. */
export function langChainStreamConfig(scope: RunTraceScope) {
  return {
    callbacks: [tracer.childOf(scope.runId)],
    runName: 'react-agent',
    metadata: { agentRunId: scope.runId },
  };
}
