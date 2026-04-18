import { describe, expect, test } from 'vitest';
import { evaluateTagFilter } from './evaluate-tag-filter.js';
import { TagAndFilter, TagOrFilter } from './tag-filter.js';

describe('evaluateTagFilter', () => {
  test('OR of leaves: any matching tag on the case satisfies one operand', () => {
    const expr = TagOrFilter.of(['a', 'b']);
    expect(evaluateTagFilter(['a'], expr)).toBe(true);
    expect(evaluateTagFilter(['b'], expr)).toBe(true);
    expect(evaluateTagFilter(['c'], expr)).toBe(false);
  });

  test('OR with no operands is false', () => {
    expect(evaluateTagFilter(['a'], TagOrFilter.of([]))).toBe(false);
  });

  test('AND with no operands is true', () => {
    expect(evaluateTagFilter([], TagAndFilter.of([]))).toBe(true);
    expect(evaluateTagFilter(['x'], TagAndFilter.of([]))).toBe(true);
  });

  test('AND of leaves requires each matcher to be hit by some tag', () => {
    const expr = TagAndFilter.of(['demo', 'short']);
    expect(evaluateTagFilter(['demo', 'short'], expr)).toBe(true);
    expect(evaluateTagFilter(['demo'], expr)).toBe(false);
    expect(evaluateTagFilter(['short'], expr)).toBe(false);
  });

  test('regex leaves use RegExp.test on tags', () => {
    const expr = TagOrFilter.of([/^tier-/]);
    expect(evaluateTagFilter(['tier-1'], expr)).toBe(true);
    expect(evaluateTagFilter(['other'], expr)).toBe(false);
  });

  test('nested OR inside AND', () => {
    const expr = TagAndFilter.of([TagOrFilter.of(['x', 'y']), 'base']);
    expect(evaluateTagFilter(['x', 'base'], expr)).toBe(true);
    expect(evaluateTagFilter(['y', 'base'], expr)).toBe(true);
    expect(evaluateTagFilter(['x'], expr)).toBe(false);
    expect(evaluateTagFilter(['base'], expr)).toBe(false);
  });

  test('nested AND inside OR', () => {
    const expr = TagOrFilter.of([TagAndFilter.of(['p', 'q']), 'solo']);
    expect(evaluateTagFilter(['p', 'q'], expr)).toBe(true);
    expect(evaluateTagFilter(['solo'], expr)).toBe(true);
    expect(evaluateTagFilter(['p'], expr)).toBe(false);
  });

  test('(demo AND short) OR (demo AND long) matches only those combinations', () => {
    const expr = TagOrFilter.of([
      TagAndFilter.of(['demo', 'short']),
      TagAndFilter.of(['demo', 'long']),
    ]);
    expect(evaluateTagFilter(['demo', 'short'], expr)).toBe(true);
    expect(evaluateTagFilter(['demo', 'long'], expr)).toBe(true);
    expect(evaluateTagFilter(['demo', 'diff'], expr)).toBe(false);
    expect(evaluateTagFilter(['short'], expr)).toBe(false);
  });
});
