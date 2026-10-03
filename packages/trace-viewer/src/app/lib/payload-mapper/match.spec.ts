import { describe, expect, it } from 'vitest';
import type { PayloadMapping } from './mapping-schema';
import { globToRegExp, matchesRule, selectRule } from './match';

const run = { type: 'chat_model', name: 'ChatOpenAI', metadata: { env: 'prod', step: 2 } };

describe('globToRegExp', () => {
  it('matches case-insensitively with * wildcards and escapes regex chars', () => {
    expect(globToRegExp('chat*').test('ChatOpenAI')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
  });
});

describe('matchesRule', () => {
  const ctx = { run, side: 'input' as const, payload: { messages: [] } };

  it('matches an empty rule', () => {
    expect(matchesRule({}, ctx)).toBe(true);
  });

  it('filters by side, run type, name, metadata and required paths', () => {
    expect(matchesRule({ side: 'output' }, ctx)).toBe(false);
    expect(matchesRule({ side: 'both' }, ctx)).toBe(true);
    expect(matchesRule({ runType: ['tool'] }, ctx)).toBe(false);
    expect(matchesRule({ runType: ['tool', 'chat_model'] }, ctx)).toBe(true);
    expect(matchesRule({ name: ['Anthropic*', 'Chat*'] }, ctx)).toBe(true);
    expect(matchesRule({ name: 'Anthropic*' }, ctx)).toBe(false);
    expect(matchesRule({ metadata: { env: 'prod', step: 2 } }, ctx)).toBe(true);
    expect(matchesRule({ metadata: { step: '2' } }, ctx)).toBe(false);
    expect(matchesRule({ requires: ['$.messages'] }, ctx)).toBe(true);
    expect(matchesRule({ requires: ['$.input'] }, ctx)).toBe(false);
  });
});

describe('selectRule', () => {
  it('returns the first matching rule in order, or null', () => {
    const mapping: PayloadMapping = {
      schemaVersion: 1,
      rules: [
        { id: 'tool', match: { runType: ['tool'] }, view: { kind: 'json' } },
        { id: 'chat', match: { runType: ['chat_model'] }, view: { kind: 'json' } },
        { id: 'any', match: {}, view: { kind: 'json' } },
      ],
    };
    expect(selectRule(mapping, { run, side: 'input', payload: {} })?.id).toBe('chat');
    expect(
      selectRule({ ...mapping, rules: [mapping.rules[0]] }, { run, side: 'input', payload: {} }),
    ).toBeNull();
  });
});
