import type { RunnableConfig } from '@langchain/core/runnables';
import type { LangGraphTracer } from '@m4trix/tracing';

export type MockLlmTurnOptions = {
  name: string;
  userPrompt: string;
  assistantText: string;
  promptTokens: number;
  completionTokens: number;
  model?: string;
};

function newRunId(): string {
  return crypto.randomUUID();
}

/**
 * Records a fake chat-model span (with token usage) under the current LangGraph node run.
 * Requires `config.runId` from LangGraph and the shared `lgTracer` callback handler.
 */
export async function runMockLlmTurn(
  tracer: LangGraphTracer,
  config: RunnableConfig | undefined,
  options: MockLlmTurnOptions,
): Promise<void> {
  const parentRunId = config?.runId;
  if (!parentRunId) return;

  const runId = newRunId();
  const model = options.model ?? 'gpt-4o-mini';
  const promptTokens = options.promptTokens;
  const completionTokens = options.completionTokens;

  await tracer.handleChatModelStart(
    { name: options.name, model },
    [[{ role: 'user', content: options.userPrompt }]],
    runId,
    parentRunId,
    undefined,
    ['mock-llm', model],
    { model, provider: 'mock' },
    options.name,
  );

  await tracer.handleLLMEnd(
    {
      generations: [[{ text: options.assistantText }]],
      llmOutput: {
        tokenUsage: {
          promptTokens,
          completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      },
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
    runId,
  );
}
