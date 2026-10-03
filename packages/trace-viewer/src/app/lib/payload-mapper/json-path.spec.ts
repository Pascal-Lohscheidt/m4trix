import { describe, expect, it } from 'vitest';
import { evaluateFirst, evaluatePath, parsePath, pathExists } from './json-path';

const doc = {
  messages: [
    { type: 'human', content: 'hi' },
    { type: 'ai', content: 'hello', tool_calls: [{ name: 'search', args: { q: 'x' } }] },
  ],
  'odd key': { nested: 1 },
  empty: null,
};

describe('parsePath', () => {
  it('parses keys, indices, wildcards and quoted keys', () => {
    expect(parsePath(`$.messages[0]['odd key'][*].*`)).toEqual({
      ok: true,
      segments: [
        { type: 'key', key: 'messages' },
        { type: 'index', index: 0 },
        { type: 'key', key: 'odd key' },
        { type: 'wildcard' },
        { type: 'wildcard' },
      ],
    });
  });

  it('accepts the bare scope', () => {
    expect(parsePath('$')).toEqual({ ok: true, segments: [] });
  });

  it.each(['messages', '$.', '$[', '$[foo]', '$..messages', '$ messages'])('rejects %s', (path) => {
    expect(parsePath(path).ok).toBe(false);
  });
});

describe('evaluatePath', () => {
  it('returns the scope for $', () => {
    expect(evaluatePath(doc, '$')).toEqual([doc]);
  });

  it('resolves nested keys and indices', () => {
    expect(evaluateFirst(doc, '$.messages[1].tool_calls[0].name')).toBe('search');
    expect(evaluateFirst(doc, '$.messages[-1].type')).toBe('ai');
    expect(evaluateFirst(doc, `$["odd key"].nested`)).toBe(1);
  });

  it('fans out over wildcards', () => {
    expect(evaluatePath(doc, '$.messages[*].type')).toEqual(['human', 'ai']);
    expect(evaluatePath({ a: { x: 1, y: 2 } }, '$.a.*')).toEqual([1, 2]);
  });

  it('returns no matches for missing paths, type mismatches and invalid paths', () => {
    expect(evaluatePath(doc, '$.missing.deep')).toEqual([]);
    expect(evaluatePath(doc, '$.messages.type')).toEqual([]);
    expect(evaluatePath(doc, '$.messages[9]')).toEqual([]);
    expect(evaluatePath(doc, 'not-a-path')).toEqual([]);
  });

  it('does not read inherited properties', () => {
    expect(evaluatePath({}, '$.constructor')).toEqual([]);
  });
});

describe('pathExists', () => {
  it('treats null as absent', () => {
    expect(pathExists(doc, '$.messages')).toBe(true);
    expect(pathExists(doc, '$.empty')).toBe(false);
    expect(pathExists(doc, '$.nope')).toBe(false);
  });
});
