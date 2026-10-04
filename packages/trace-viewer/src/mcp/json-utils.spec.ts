import { describe, expect, it } from 'vitest';
import {
  decodeJsonStrings,
  evaluateWithPaths,
  flattenLeaves,
  outlinePayload,
  previewPayload,
  snippetAround,
} from './json-utils';

describe('decodeJsonStrings', () => {
  it('parses nested JSON strings but leaves other strings alone', () => {
    expect(decodeJsonStrings({ args: '{"q":"[1,2]"}', text: '{not json', plain: 'hi' })).toEqual({
      args: { q: [1, 2] },
      text: '{not json',
      plain: 'hi',
    });
  });
});

describe('flattenLeaves', () => {
  it('emits scalar leaves with paths that evaluateWithPaths accepts', () => {
    const value = { a: [{ 'b-c': 'x' }, 2], 'odd key': true, nothing: null };
    const leaves = flattenLeaves(value);
    expect(leaves).toEqual([
      { path: '$.a[0].b-c', text: 'x' },
      { path: '$.a[1]', text: '2' },
      { path: '$["odd key"]', text: 'true' },
    ]);
    for (const leaf of leaves) {
      const result = evaluateWithPaths(value, leaf.path);
      expect(result.ok && result.matches.map((match) => String(match.value))).toEqual([leaf.text]);
    }
  });
});

describe('evaluateWithPaths', () => {
  it('returns concrete paths for wildcards and negative indexes', () => {
    const value = { items: [{ id: 1 }, { id: 2 }] };
    expect(evaluateWithPaths(value, '$.items[*].id')).toEqual({
      ok: true,
      matches: [
        { path: '$.items[0].id', value: 1 },
        { path: '$.items[1].id', value: 2 },
      ],
    });
    expect(evaluateWithPaths(value, '$.items[-1]')).toEqual({
      ok: true,
      matches: [{ path: '$.items[1]', value: { id: 2 } }],
    });
  });

  it('reports invalid paths and returns no matches for missing segments', () => {
    expect(evaluateWithPaths({}, 'items').ok).toBe(false);
    expect(evaluateWithPaths({ a: 1 }, '$.b')).toEqual({ ok: true, matches: [] });
  });
});

describe('outlinePayload', () => {
  it('summarizes types, sizes and collapses long arrays', () => {
    const outline = outlinePayload({ messages: [1, 2, 3, 4, 5], note: 'hello' }, '$', {
      maxArrayItems: 2,
    });
    expect(outline).toContain('$  object{2}');
    expect(outline).toContain('$.messages  array[5]');
    expect(outline).toContain('… 3 more items');
    expect(outline).toContain('$.note  string(5) "hello"');
  });

  it('caps the number of lines', () => {
    const outline = outlinePayload(
      Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])),
      '$',
      {
        maxLines: 5,
      },
    );
    expect(outline).toContain('outline truncated at 5 lines');
  });
});

describe('previewPayload / snippetAround', () => {
  it('returns JSON when small and an outline when large', () => {
    expect(previewPayload({ a: 1 }, 100)).toBe('{"a":1}');
    expect(previewPayload({ text: 'x'.repeat(500) }, 100)).toContain('outline shown');
  });

  it('cuts a single-line window around the match', () => {
    expect(snippetAround(`${'a'.repeat(200)}NEEDLE\n${'b'.repeat(200)}`, 200, 6, 5)).toBe(
      '…aaaaaNEEDLE ⏎ bbbb…',
    );
  });
});
