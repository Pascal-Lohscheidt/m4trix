import { describe, expect, expectTypeOf, it } from 'vitest';
import { type PayloadMapping, STARTER_MAPPING, validateMapping } from './mapping-schema';

describe('validateMapping', () => {
  it('accepts the starter mapping', () => {
    const result = validateMapping(STARTER_MAPPING);
    expect(result.ok).toBe(true);
    if (result.ok) expectTypeOf(result.mapping).toEqualTypeOf<PayloadMapping>();
  });

  it('accepts nested stack / toolResult views', () => {
    const result = validateMapping({
      schemaVersion: 1,
      rules: [
        {
          id: 'r',
          match: {
            runType: ['tool'],
            name: ['search*'],
            side: 'output',
            metadata: { env: 'prod' },
          },
          view: {
            kind: 'stack',
            children: [
              { kind: 'toolResult', body: { kind: 'markdown', value: '$.content' } },
              { kind: 'table', rows: '$.hits[*]', columns: [{ label: 'Title', value: '$.title' }] },
            ],
          },
        },
      ],
      usage: [{ inputTokens: '$.usage.input_tokens', model: '$.model' }],
      metadata: { pick: ['thread_id'], labels: { thread_id: 'Thread' } },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('reports invalid paths with their location', () => {
    const result = validateMapping({
      schemaVersion: 1,
      rules: [{ id: 'r', match: {}, view: { kind: 'markdown', value: 'content' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatch(/^rules\.0\.view\.value: Path must start with "\$"/);
  });

  it('rejects unknown view kinds, unknown keys and duplicate rule ids', () => {
    const base = { schemaVersion: 1 as const };
    expect(
      validateMapping({ ...base, rules: [{ id: 'r', match: {}, view: { kind: 'chart' } }] }).ok,
    ).toBe(false);
    expect(
      validateMapping({
        ...base,
        rules: [{ id: 'r', match: {}, view: { kind: 'json' }, extra: 1 }],
      }).ok,
    ).toBe(false);
    const dup = validateMapping({
      ...base,
      rules: [
        { id: 'r', match: {}, view: { kind: 'json' } },
        { id: 'r', match: {}, view: { kind: 'json' } },
      ],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors).toContain('rules.1.id: Duplicate rule id "r"');
  });

  it('rejects other schema versions', () => {
    expect(validateMapping({ schemaVersion: 2, rules: [] }).ok).toBe(false);
  });
});
