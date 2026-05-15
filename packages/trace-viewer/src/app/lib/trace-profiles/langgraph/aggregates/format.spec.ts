import { describe, expect, it } from 'vitest';
import { formatSubtreeRollupTitle, formatSubtreeTokenCount, subtreeRollupTotalTokens } from './format';
import type { RunSubtreeRollup } from './types';

function rollup(partial: Partial<RunSubtreeRollup>): RunSubtreeRollup {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    hasUsage: false,
    ...partial,
  };
}

describe('subtreeRollupTotalTokens', () => {
  it('prefers explicit totalTokens', () => {
    expect(subtreeRollupTotalTokens(rollup({ totalTokens: 50, promptTokens: 10, completionTokens: 5 }))).toBe(
      50,
    );
  });

  it('falls back to prompt plus completion', () => {
    expect(subtreeRollupTotalTokens(rollup({ promptTokens: 10, completionTokens: 5 }))).toBe(15);
  });
});

describe('formatSubtreeTokenCount', () => {
  it('returns null when no tokens', () => {
    expect(formatSubtreeTokenCount(rollup({}))).toBeNull();
  });

  it('formats token count without unit suffix', () => {
    expect(formatSubtreeTokenCount(rollup({ totalTokens: 12_500 }))).toBe('12.5k');
  });
});

describe('formatSubtreeRollupTitle', () => {
  it('includes token breakdown and cost in tooltip text', () => {
    const title = formatSubtreeRollupTitle(
      rollup({
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
        costUsd: 0.001234,
        hasUsage: true,
      }),
    );
    expect(title).toContain('Subtree total');
    expect(title).toContain('Tokens: 125');
    expect(title).toContain('Prompt: 100');
    expect(title).toContain('Completion: 25');
    expect(title).toContain('Reported cost');
  });
});
