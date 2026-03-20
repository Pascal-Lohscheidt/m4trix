import { Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';

import { Dataset } from './dataset';
import { Evaluator } from './evaluator';
import { RunConfig, validateRunConfigName } from './run-config';

describe('RunConfig', () => {
  const ds = Dataset.define({ name: 'd1' });
  const inputSchema = S.Struct({ x: S.Number });
  const outputSchema = S.Struct({ y: S.Number });
  const scoreSchema = S.Struct({ z: S.Number });
  const ev = Evaluator.use({ name: 'noop', resolve: () => ({}) }).define({
    name: 'e1',
    inputSchema,
    outputSchema,
    scoreSchema,
  });

  test('define() validates name and runs', () => {
    expect(() =>
      RunConfig.define({ name: '', runs: [{ dataset: ds, evaluators: [ev] }] }),
    ).toThrow();
    expect(() => RunConfig.define({ name: 'x', runs: [] })).toThrow();
    expect(() =>
      RunConfig.define({ name: 'x', runs: [{ dataset: ds, evaluators: [] }] }),
    ).toThrow();
    expect(() =>
      RunConfig.define({
        name: 'x',
        runs: [{ dataset: ds, evaluators: [ev], evaluatorPattern: 'x' }],
      }),
    ).toThrow();
  });

  test('define() accepts optional displayName for CLI label', () => {
    const rc = RunConfig.define({
      name: 'nightly',
      displayName: 'Nightly (EU)',
      runs: [{ dataset: ds, evaluators: [ev] }],
    });
    expect(rc.getName()).toBe('nightly');
    expect(rc.getDisplayName()).toBe('Nightly (EU)');
    expect(rc.getDisplayLabel()).toBe('Nightly (EU)');
    const bare = RunConfig.define({
      name: 'smoke',
      runs: [{ dataset: ds, evaluators: [ev] }],
    });
    expect(bare.getDisplayName()).toBeUndefined();
    expect(bare.getDisplayLabel()).toBe('smoke');
  });

  test('define() accepts evaluator instances or pattern', () => {
    const a = RunConfig.define({
      name: 'a',
      runs: [{ dataset: ds, evaluators: [ev] }],
    });
    expect(a.getName()).toBe('a');
    expect(a.getRuns()).toHaveLength(1);

    const b = RunConfig.define({
      name: 'b',
      runs: [{ dataset: ds, evaluatorPattern: 'e*' }],
    });
    expect(b.getRuns()[0]).toMatchObject({ evaluatorPattern: 'e*' });
  });

  test('define() accepts kebab-case, snake_case, and camelCase names', () => {
    expect(
      RunConfig.define({
        name: 'my-nightly',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }).getName(),
    ).toBe('my-nightly');
    expect(
      RunConfig.define({
        name: 'my_nightly',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }).getName(),
    ).toBe('my_nightly');
    expect(
      RunConfig.define({
        name: 'myNightly',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }).getName(),
    ).toBe('myNightly');
    expect(
      RunConfig.define({
        name: 'a--b',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }).getName(),
    ).toBe('a--b');
  });

  test('define() rejects whitespace and other invalid characters in name', () => {
    expect(() =>
      RunConfig.define({
        name: 'Example Name',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }),
    ).toThrow(/no spaces/);
    expect(() =>
      RunConfig.define({
        name: 'foo\tbar',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }),
    ).toThrow(/letters, digits, underscores, and hyphens/);
    expect(() =>
      RunConfig.define({
        name: 'foo.bar',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }),
    ).toThrow(/letters, digits, underscores, and hyphens/);
    expect(() =>
      RunConfig.define({
        name: 'foo@bar',
        runs: [{ dataset: ds, evaluators: [ev] }],
      }),
    ).toThrow(/letters, digits, underscores, and hyphens/);
  });

  test('validateRunConfigName() trims and preserves casing', () => {
    expect(validateRunConfigName('  myNightly  ', 'test')).toBe('myNightly');
    expect(validateRunConfigName('MY_RUN', 'test')).toBe('MY_RUN');
  });

  test('define() rejects invalid repetitions', () => {
    expect(() =>
      RunConfig.define({
        name: 'bad-rep',
        runs: [{ dataset: ds, evaluators: [ev], repetitions: 0 }],
      }),
    ).toThrow(/repetitions must be a positive integer/);
    expect(() =>
      RunConfig.define({
        name: 'bad-rep-2',
        runs: [{ dataset: ds, evaluators: [ev], repetitions: 1.5 }],
      }),
    ).toThrow(/repetitions must be a positive integer/);
  });
});
