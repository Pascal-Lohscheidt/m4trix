import { describe, expect, it } from 'vitest';
import { extractMetadataUsage } from './extract-metadata';

describe('extractMetadataUsage', () => {
  it('reads token fields from metadata', () => {
    expect(
      extractMetadataUsage({
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
      }),
    ).toEqual({
      tokens: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    });
  });

  it('derives total when only prompt and completion are set', () => {
    expect(
      extractMetadataUsage({
        input_tokens: 50,
        output_tokens: 20,
      }),
    ).toEqual({
      tokens: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
    });
  });

  it('returns cost only when no token fields exist', () => {
    expect(extractMetadataUsage({ cost_usd: 0.004 })).toEqual({ costUsd: 0.004 });
  });

  it('returns empty for undefined metadata', () => {
    expect(extractMetadataUsage(undefined)).toEqual({});
  });
});
