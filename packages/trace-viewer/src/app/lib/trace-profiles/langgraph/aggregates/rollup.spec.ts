import { describe, expect, it } from 'vitest';
import { addUsageToRollup } from './rollup';

describe('addUsageToRollup', () => {
  it('adds prompt, completion, and total independently', () => {
    const rollup = { promptTokens: 10, completionTokens: 5, totalTokens: 0 };
    addUsageToRollup(rollup, { promptTokens: 3, completionTokens: 2, totalTokens: 20 });
    expect(rollup).toEqual({ promptTokens: 13, completionTokens: 7, totalTokens: 20 });
  });

  it('ignores undefined partial fields', () => {
    const rollup = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    addUsageToRollup(rollup, { completionTokens: 4 });
    expect(rollup.promptTokens).toBe(1);
    expect(rollup.completionTokens).toBe(6);
    expect(rollup.totalTokens).toBe(3);
  });
});
