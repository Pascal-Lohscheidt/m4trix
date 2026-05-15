import { describe, expect, it } from 'vitest';
import { extractUsageFromUnknown } from './extract-usage';

describe('extractUsageFromUnknown', () => {
  it('reads OpenAI-style usage on the root object', () => {
    expect(
      extractUsageFromUnknown({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('walks nested response_metadata', () => {
    expect(
      extractUsageFromUnknown({
        response_metadata: { token_usage: { input_tokens: 8, output_tokens: 3 } },
      }),
    ).toEqual({ promptTokens: 8, completionTokens: 3, totalTokens: 11 });
  });

  it('derives total from prompt and completion when total is missing', () => {
    expect(
      extractUsageFromUnknown({
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
    ).toEqual({ promptTokens: 100, completionTokens: 40, totalTokens: 140 });
  });

  it('sums cost fields when present', () => {
    expect(
      extractUsageFromUnknown({
        costUsd: 0.01,
        response: { cost_usd: 0.02 },
      }),
    ).toEqual({ costUsd: 0.03 });
  });

  it('returns empty object for nullish input', () => {
    expect(extractUsageFromUnknown(null)).toEqual({});
    expect(extractUsageFromUnknown(undefined)).toEqual({});
  });
});
