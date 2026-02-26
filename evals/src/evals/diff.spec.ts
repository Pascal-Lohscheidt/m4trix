import { describe, expect, test } from 'vitest';
import {
  createDiffLogEntry,
  getDiffLines,
  getDiffString,
  printJsonDiff,
} from './diff';

describe('diff', () => {
  test('object key reorder produces no differences', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { z: 3, x: 1, y: 2 };
    const entry = createDiffLogEntry(a, b);
    expect(entry.diff).toBe('(no differences)');
    expect(getDiffString(entry)).toBe('(no differences)');
    const lines = getDiffLines(entry);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ type: 'context', line: '(no differences)' });
  });

  test('actual value change produces remove/add lines', () => {
    const expected = { name: 'Alice', age: 30 };
    const actual = { name: 'Bob', age: 30 };
    const entry = createDiffLogEntry(expected, actual);
    expect(entry.diff).not.toBe('(no differences)');
    expect(entry.diff).toContain('-');
    expect(entry.diff).toContain('+');
    expect(entry.diff).toContain('name');
    expect(entry.diff).toContain('Alice');
    expect(entry.diff).toContain('Bob');
    const lines = getDiffLines(entry);
    const removes = lines.filter((l) => l.type === 'remove');
    const adds = lines.filter((l) => l.type === 'add');
    expect(removes.length).toBeGreaterThan(0);
    expect(adds.length).toBeGreaterThan(0);
  });

  test('nested structure diff produces path-aware lines', () => {
    const expected = { user: { name: 'Alice', settings: { theme: 'dark' } } };
    const actual = { user: { name: 'Bob', settings: { theme: 'light' } } };
    const entry = createDiffLogEntry(expected, actual);
    expect(entry.diff).toContain('Alice');
    expect(entry.diff).toContain('Bob');
    expect(entry.diff).toContain('dark');
    expect(entry.diff).toContain('light');
  });

  test('createDiffLogEntry accepts diff options', () => {
    const expected = { a: 1, b: 2 };
    const actual = { a: 2, b: 2 };
    const entryFull = createDiffLogEntry(expected, actual, { full: true });
    expect(entryFull.diff).toContain('b');
    const entrySort = createDiffLogEntry([3, 1, 2], [2, 1, 3], { sort: true });
    expect(entrySort.diff).toBe('(no differences)');
  });

  test('identical primitives produce no differences', () => {
    expect(createDiffLogEntry(42, 42).diff).toBe('(no differences)');
    expect(createDiffLogEntry('hello', 'hello').diff).toBe('(no differences)');
    expect(createDiffLogEntry(null, null).diff).toBe('(no differences)');
  });

  test('getDiffLines returns correct type annotations', () => {
    const entry = createDiffLogEntry({ a: 1 }, { a: 2 });
    const lines = getDiffLines(entry);
    expect(lines.some((l) => l.type === 'remove')).toBe(true);
    expect(lines.some((l) => l.type === 'add')).toBe(true);
    for (const { type, line } of lines) {
      if (type === 'remove') expect(line.trimStart().startsWith('-')).toBe(true);
      if (type === 'add') expect(line.trimStart().startsWith('+')).toBe(true);
    }
  });

  test('printJsonDiff returns diff string', () => {
    const result = printJsonDiff({ x: 1 }, { x: 2 }, { color: false });
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result).toContain('-');
    expect(result).toContain('+');
  });
});
