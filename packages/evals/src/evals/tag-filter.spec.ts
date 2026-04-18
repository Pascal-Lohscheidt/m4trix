import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  isTagAndFilter,
  isTagOrFilter,
  TagAndFilter,
  type TagAndFilterExpression,
  TagOrFilter,
  type TagOrFilterExpression,
} from './tag-filter.js';

describe('TagAndFilter', () => {
  test('of() freezes the instance and operands', () => {
    const inner = TagOrFilter.of(['a']);
    const expr = TagAndFilter.of(['x', inner]);
    expect(Object.isFrozen(expr)).toBe(true);
    expect(Object.isFrozen(expr.operands)).toBe(true);
    expect(expr.kind).toBe('and');
  });

  test('of() accepts string leaves and TagOrFilter operands', () => {
    const expr = TagAndFilter.of([/^foo/, TagOrFilter.of(['a', 'b'])]);
    expect(expr.operands).toHaveLength(2);
    expect(isTagOrFilter(expr.operands[1])).toBe(true);
  });
});

describe('TagOrFilter', () => {
  test('of() freezes the instance and operands', () => {
    const inner = TagAndFilter.of(['p', 'q']);
    const expr = TagOrFilter.of(['z', inner]);
    expect(Object.isFrozen(expr)).toBe(true);
    expect(Object.isFrozen(expr.operands)).toBe(true);
    expect(expr.kind).toBe('or');
  });

  test('of() accepts string leaves and TagAndFilter operands', () => {
    const expr = TagOrFilter.of(['solo', TagAndFilter.of(['u', 'v'])]);
    expect(expr.operands).toHaveLength(2);
    expect(isTagAndFilter(expr.operands[1])).toBe(true);
  });
});

describe('type guards', () => {
  test('isTagOrFilter and isTagAndFilter distinguish nested values', () => {
    const orExpr = TagOrFilter.of([]);
    const andExpr = TagAndFilter.of([]);
    expect(isTagOrFilter(orExpr)).toBe(true);
    expect(isTagAndFilter(orExpr)).toBe(false);
    expect(isTagAndFilter(andExpr)).toBe(true);
    expect(isTagOrFilter(andExpr)).toBe(false);
    expect(isTagOrFilter(['not', 'a', 'filter'])).toBe(false);
    expect(isTagAndFilter({ kind: 'and', operands: [] })).toBe(true);
    expect(isTagAndFilter({ kind: 'and', operands: [1, 2] })).toBe(false);
  });
});

describe('operand type variance', () => {
  test('TagAndFilter operands are string, RegExp, or TagOrFilter only', () => {
    const v = TagAndFilter.of(['a', /x/, TagOrFilter.of(['b'])]);
    expectTypeOf(v.operands[0]).toEqualTypeOf<string | RegExp | TagOrFilterExpression>();
  });

  test('TagOrFilter operands are string, RegExp, or TagAndFilter only', () => {
    const v = TagOrFilter.of(['a', /x/, TagAndFilter.of(['b'])]);
    expectTypeOf(v.operands[0]).toEqualTypeOf<string | RegExp | TagAndFilterExpression>();
  });
});
