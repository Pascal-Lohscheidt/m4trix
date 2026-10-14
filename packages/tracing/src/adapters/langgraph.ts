import type { Tracer } from '../tracer.js';

/**
 * Callback surface passed to LangGraph / LangChain `callbacks` without importing those packages.
 */
export type LangGraphTracer = Pick<
  Tracer,
  | 'name'
  | 'awaitHandlers'
  | 'flush'
  | 'handleChainStart'
  | 'handleChainEnd'
  | 'handleChainError'
  | 'handleLLMStart'
  | 'handleLLMNewToken'
  | 'handleLLMEnd'
  | 'handleLLMError'
  | 'handleChatModelStart'
  | 'handleToolStart'
  | 'handleToolEnd'
  | 'handleToolError'
  | 'handleRetrieverStart'
  | 'handleRetrieverEnd'
  | 'handleRetrieverError'
  | 'handleText'
  | 'handleAgentAction'
  | 'handleAgentEnd'
  | 'handleCustomEvent'
>;

export function toLangGraph(tracer: Tracer): LangGraphTracer {
  return tracer;
}
