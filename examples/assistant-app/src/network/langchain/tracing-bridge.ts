import type { RunTraceScope } from '@m4trix/core/matrix';
import { toLangGraph, type LangGraphTracer } from '@m4trix/tracing';

import { tracer } from '../../tracing/setup.js';

function defaultParent(parentRunId: string | undefined, fallback: string): string | undefined {
  return parentRunId ?? fallback;
}

/** Attach LangChain runs under the m4trix agent invoke span when LC omits parentRunId. */
function withParentRun(base: LangGraphTracer, fallbackParentRunId: string): LangGraphTracer {
  return {
    name: base.name,
    awaitHandlers: base.awaitHandlers,
    flush: base.flush.bind(base),
    handleChainStart: async (...args) => {
      const parentRunId = defaultParent(args[3], fallbackParentRunId);
      return base.handleChainStart(
        args[0],
        args[1],
        args[2],
        parentRunId,
        args[4],
        args[5],
        args[6],
        args[7],
      );
    },
    handleChainEnd: base.handleChainEnd.bind(base),
    handleChainError: base.handleChainError.bind(base),
    handleLLMStart: async (...args) => {
      const parentRunId = defaultParent(args[3], fallbackParentRunId);
      return base.handleLLMStart(
        args[0],
        args[1],
        args[2],
        parentRunId,
        args[4],
        args[5],
        args[6],
        args[7],
      );
    },
    handleLLMEnd: base.handleLLMEnd.bind(base),
    handleLLMError: base.handleLLMError.bind(base),
    handleChatModelStart: async (...args) => {
      const parentRunId = defaultParent(args[3], fallbackParentRunId);
      return base.handleChatModelStart(
        args[0],
        args[1],
        args[2],
        parentRunId,
        args[4],
        args[5],
        args[6],
        args[7],
      );
    },
    handleToolStart: async (...args) => {
      const parentRunId = defaultParent(args[3], fallbackParentRunId);
      return base.handleToolStart(
        args[0],
        args[1],
        args[2],
        parentRunId,
        args[4],
        args[5],
        args[6],
      );
    },
    handleToolEnd: base.handleToolEnd.bind(base),
    handleToolError: base.handleToolError.bind(base),
    handleRetrieverStart: async (...args) => {
      const parentRunId = defaultParent(args[3], fallbackParentRunId);
      return base.handleRetrieverStart(
        args[0],
        args[1],
        args[2],
        parentRunId,
        args[4],
        args[5],
        args[6],
      );
    },
    handleRetrieverEnd: base.handleRetrieverEnd.bind(base),
    handleRetrieverError: base.handleRetrieverError.bind(base),
  };
}

export function createLangChainCallbacks(scope: RunTraceScope): LangGraphTracer {
  return withParentRun(toLangGraph(tracer), scope.runId);
}

export function langChainStreamConfig(scope: RunTraceScope) {
  return {
    callbacks: [createLangChainCallbacks(scope)],
    runName: 'react-agent',
    metadata: {
      projectId: scope.contextId,
      agentRunId: scope.runId,
    },
  };
}
