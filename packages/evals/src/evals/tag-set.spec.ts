import { describe, expect, expectTypeOf, test } from 'vitest';
import { TagSet, type TagSetMembers } from './tag-set.js';

describe('TagSet', () => {
  test('define() maps each tag to itself at runtime', () => {
    const t = TagSet.define(['demo', 'short'] as const);
    expect(t.demo).toBe('demo');
    expect(t.short).toBe('short');
  });

  test('define() infers keys from a tuple literal without as const on the call', () => {
    const t = TagSet.define(['alpha', 'beta']);
    expectTypeOf(t.alpha).toEqualTypeOf<string>();
    expectTypeOf(t.beta).toEqualTypeOf<string>();
    expect(t.alpha).toBe('alpha');
  });

  test('empty define yields an empty object', () => {
    const t = TagSet.define([]);
    expect(t).toEqual({});
    expectTypeOf(t).toEqualTypeOf<TagSetMembers<[]>>();
  });

  test('unknown tag keys are type errors (see @ts-expect-error)', () => {
    const t = TagSet.define(['known']);
    expect(t.known).toBe('known');
    // @ts-expect-error — not a defined tag
    t.unknown;

    // @ts-expect-error — not a defined tag
    t['unknown-tag'];
  });
});
