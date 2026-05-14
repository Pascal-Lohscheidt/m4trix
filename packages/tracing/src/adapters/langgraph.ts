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
  | 'handleLLMEnd'
  | 'handleLLMError'
  | 'handleChatModelStart'
  | 'handleToolStart'
  | 'handleToolEnd'
  | 'handleToolError'
  | 'handleRetrieverStart'
  | 'handleRetrieverEnd'
  | 'handleRetrieverError'
>;

export function toLangGraph(tracer: Tracer): LangGraphTracer {
  return tracer;
}
