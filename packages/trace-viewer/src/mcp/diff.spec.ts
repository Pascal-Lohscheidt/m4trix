import { describe, expect, it } from 'vitest';
import { diffJson, formatJsonChanges } from './diff';

describe('diffJson', () => {
  it('reports added, removed and changed paths', () => {
    const { changes, truncated } = diffJson(
      { a: 1, list: [1, 2], gone: true, same: { x: 1 } },
      { a: 2, list: [1, 2, 3], added: 'y', same: { x: 1 } },
    );
    expect(truncated).toBe(false);
    expect(formatJsonChanges(changes)).toBe(
      ['~ $.a: 1 → 2', '+ $.list[2]: 3', '- $.gone: true', '+ $.added: "y"'].join('\n'),
    );
  });

  it('treats type changes as a single change and respects maxChanges', () => {
    expect(diffJson({ a: [1] }, { a: { 0: 1 } }).changes).toEqual([
      { kind: 'changed', path: '$.a', before: [1], after: { 0: 1 } },
    ]);
    const { changes, truncated } = diffJson([1, 2, 3], [4, 5, 6], 2);
    expect(changes).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('returns no changes for equal values', () => {
    expect(diffJson({ a: [{ b: 'c' }] }, { a: [{ b: 'c' }] }).changes).toEqual([]);
  });
});
