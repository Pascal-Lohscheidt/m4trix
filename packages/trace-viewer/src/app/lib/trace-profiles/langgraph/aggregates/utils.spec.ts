import { describe, expect, it } from 'vitest';
import { finalizeTokenRollup, formatTokenCount, readFiniteNumber } from './utils';

describe('readFiniteNumber', () => {
  it('parses numbers and numeric strings', () => {
    expect(readFiniteNumber(42)).toBe(42);
    expect(readFiniteNumber('99')).toBe(99);
  });

  it('returns null for invalid values', () => {
    expect(readFiniteNumber('')).toBeNull();
    expect(readFiniteNumber('nope')).toBeNull();
    expect(readFiniteNumber(Number.NaN)).toBeNull();
  });
});

describe('finalizeTokenRollup', () => {
  it('fills total from prompt and completion when total is zero', () => {
    const rollup = { promptTokens: 10, completionTokens: 5, totalTokens: 0 };
    finalizeTokenRollup(rollup);
    expect(rollup.totalTokens).toBe(15);
  });
});

describe('formatTokenCount', () => {
  it('formats large counts compactly', () => {
    expect(formatTokenCount(9999)).toBe('9999');
    expect(formatTokenCount(10_000)).toBe('10.0k');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
  });
});
