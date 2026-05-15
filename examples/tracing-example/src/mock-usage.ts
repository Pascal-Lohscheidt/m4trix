/** OpenAI-style usage block for trace viewer LangGraph profile extraction. */
export type MockUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type MockUsageOptions = {
  promptTokens: number;
  completionTokens: number;
  model?: string;
  /** Optional reported cost in USD (not estimated by the viewer). */
  costUsd?: number;
};

export function mockUsage(options: MockUsageOptions): MockUsage {
  const prompt_tokens = options.promptTokens;
  const completion_tokens = options.completionTokens;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}

/** Attach usage fields that `extractUsageFromUnknown` recognizes on tool/payload JSON. */
export function withMockUsage<T extends Record<string, unknown>>(
  payload: T,
  options: MockUsageOptions,
): T & {
  usage: MockUsage;
  response_metadata: { model: string; token_usage: MockUsage };
  costUsd?: number;
} {
  const usage = mockUsage(options);
  const model = options.model ?? 'gpt-4o-mini';
  return {
    ...payload,
    usage,
    response_metadata: {
      model,
      token_usage: usage,
    },
    ...(options.costUsd != null ? { costUsd: options.costUsd } : {}),
  };
}
