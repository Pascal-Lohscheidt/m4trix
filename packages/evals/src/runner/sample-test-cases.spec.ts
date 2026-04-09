import { Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';

import { TestCase } from '../evals/test-case';
import type { CollectedTestCase } from './events';
import { isRunConfigSamplingActive, sampleCollectedTestCases } from './sample-test-cases';

function makeCase(id: string): CollectedTestCase {
  const inputSchema = S.Struct({ x: S.Number });
  const outputSchema = S.Struct({ y: S.Number });
  const tc = TestCase.describe({
    name: id,
    inputSchema,
    outputSchema,
    input: { x: 1 },
    output: { y: 2 },
  });
  return { id, filePath: `${id}.ts`, testCase: tc };
}

describe('sampleCollectedTestCases', () => {
  test('full dataset when sampling inactive', () => {
    const cases = [makeCase('a'), makeCase('b')];
    expect(sampleCollectedTestCases(cases, undefined)).toHaveLength(2);
    expect(sampleCollectedTestCases(cases, {})).toHaveLength(2);
    expect(sampleCollectedTestCases(cases, { seed: 'only-seed' })).toHaveLength(2);
  });

  test('isRunConfigSamplingActive', () => {
    expect(isRunConfigSamplingActive(undefined)).toBe(false);
    expect(isRunConfigSamplingActive({})).toBe(false);
    expect(isRunConfigSamplingActive({ seed: 'x' })).toBe(false);
    expect(isRunConfigSamplingActive({ count: 1 })).toBe(true);
    expect(isRunConfigSamplingActive({ percent: 10 })).toBe(true);
  });

  test('count caps at dataset size', () => {
    const cases = [makeCase('a'), makeCase('b')];
    const out = sampleCollectedTestCases(cases, { count: 10, seed: 's' });
    expect(out).toHaveLength(2);
  });

  test('percent 100 includes all', () => {
    const cases = [makeCase('a'), makeCase('b'), makeCase('c')];
    const out = sampleCollectedTestCases(cases, { percent: 100, seed: 'fixed' });
    expect(out).toHaveLength(3);
  });

  test('same seed yields same subset for count', () => {
    const cases = Array.from({ length: 20 }, (_, i) => makeCase(`c${i}`));
    const a = sampleCollectedTestCases(cases, { count: 5, seed: 'my-seed' });
    const b = sampleCollectedTestCases(cases, { count: 5, seed: 'my-seed' });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  test('different seeds can yield different subsets for count', () => {
    const cases = Array.from({ length: 30 }, (_, i) => makeCase(`c${i}`));
    const a = sampleCollectedTestCases(cases, { count: 5, seed: 'seed-a' });
    const b = sampleCollectedTestCases(cases, { count: 5, seed: 'seed-b' });
    const same =
      a.length === b.length && a.every((item, i) => item.id === b[i]?.id);
    expect(same).toBe(false);
  });
});
