import { describe, expect, it } from 'vitest';
import { addTokens, costOf, priceTable } from './cost.js';

describe('priceTable', () => {
  const cost = priceTable({
    'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
  const tokens = { input: 1_000_000, output: 1_000_000 };

  it('prices an exact model id', () => {
    expect(cost({ model: 'gpt-4o', tokens })).toBeCloseTo(12.5);
  });

  it('prices dated snapshots by the longest matching prefix', () => {
    expect(cost({ model: 'gpt-4o-2024-08-06', tokens })).toBeCloseTo(12.5);
    expect(cost({ model: 'gpt-4o-mini-2024-07-18', tokens })).toBeCloseTo(0.75);
  });

  it('cannot price unknown or missing models', () => {
    expect(cost({ model: 'llama-3', tokens })).toBeUndefined();
    expect(cost({ tokens })).toBeUndefined();
  });
});

describe('costOf', () => {
  it('prices cache reads and writes at their own rates, as parts of the input', () => {
    const usd = costOf(
      { input: 1_000_000, output: 100_000, cached: 600_000, cacheCreation: 300_000 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    );

    // 100k uncached input, 600k cache reads, 300k cache writes, 100k output
    expect(usd).toBeCloseTo(0.3 + 0.18 + 1.125 + 1.5);
  });

  it('falls back to the input rate for cache tokens without a rate', () => {
    expect(
      costOf({ input: 1_000_000, output: 0, cached: 500_000 }, { input: 2, output: 8 }),
    ).toBeCloseTo(2);
  });

  it('never counts negative uncached input from inconsistent usage', () => {
    expect(
      costOf({ input: 10, output: 0, cached: 50 }, { input: 1, output: 1, cacheRead: 1 }),
    ).toBeCloseTo(50 / 1_000_000);
  });
});

describe('addTokens', () => {
  it('adds totals and keeps detail counts only when reported', () => {
    expect(addTokens(undefined, { input: 3, output: 4 })).toEqual({ input: 3, output: 4 });
    expect(
      addTokens({ input: 3, output: 4 }, { input: 1, output: 1, cached: 2, reasoning: 1 }),
    ).toEqual({
      input: 4,
      output: 5,
      cached: 2,
      reasoning: 1,
    });
    expect(
      addTokens(
        { input: 1, output: 1, cacheCreation: 5 },
        { input: 1, output: 1, cacheCreation: 2 },
      ),
    ).toEqual({ input: 2, output: 2, cacheCreation: 7 });
  });
});
