import { describe, expect, it } from 'vitest';
import type { MappingRule, PayloadMapping } from './mapping-schema';
import { diffMappings } from './rule-diff';

const rule = (id: string, value = '$.a'): MappingRule => ({
  id,
  match: {},
  view: { kind: 'text', value },
});
const mapping = (rules: MappingRule[], extra: Partial<PayloadMapping> = {}): PayloadMapping => ({
  schemaVersion: 1,
  rules,
  ...extra,
});

describe('diffMappings', () => {
  it('classifies added, removed, changed, unchanged and moved rules', () => {
    const diff = diffMappings(
      mapping([rule('a'), rule('b'), rule('c'), rule('gone')]),
      mapping([rule('new'), rule('b', '$.b'), rule('a'), rule('c')], {
        usage: [{ inputTokens: '$.u' }],
      }),
    );
    expect(diff.rules.map((r) => [r.type, r.id, 'moved' in r ? r.moved : null])).toEqual([
      ['added', 'new', null],
      ['changed', 'b', true],
      ['unchanged', 'a', true],
      ['unchanged', 'c', false],
      ['removed', 'gone', null],
    ]);
    expect(diff).toMatchObject({ metadataChanged: false, usageChanged: true });
  });

  it('reports no changes for identical mappings', () => {
    const m = mapping([rule('a'), rule('b')], { metadata: { pick: ['x'] } });
    const diff = diffMappings(m, structuredClone(m));
    expect(diff.rules.every((r) => r.type === 'unchanged' && !r.moved)).toBe(true);
    expect(diff).toMatchObject({ metadataChanged: false, usageChanged: false });
  });
});
