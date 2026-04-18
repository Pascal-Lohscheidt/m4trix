import { Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';

import { Dataset } from './dataset.js';
import { Evaluator } from './evaluator.js';
import { RunConfig, validateRunConfigName } from './run-config.js';

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
        // @ts-expect-error — evaluatorPattern is not a string
        runs: [{ dataset: ds, evaluators: [ev], evaluatorPattern: 'x' }],
      }),
    ).toThrow();
  });

  test('define() stores optional tags', () => {
    const rc = RunConfig.define({
      name: 'tagged-rc',
      tags: ['suite-a', 'ci'],
      runs: [{ dataset: ds, evaluators: [ev] }],
    });
    expect(rc.getTags()).toEqual(['suite-a', 'ci']);
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

  test('define() accepts optional sampling per row', () => {
    const rc = RunConfig.define({
      name: 'sample-rc',
      runs: [
        { dataset: ds, evaluators: [ev], sampling: { count: 3, seed: 'nightly' } },
        { dataset: ds, evaluatorPattern: 'e*', sampling: { percent: 25 } },
      ],
    });
    expect(rc.getRuns()[0]).toMatchObject({ sampling: { count: 3, seed: 'nightly' } });
    expect(rc.getRuns()[1]).toMatchObject({ sampling: { percent: 25 } });
  });

  test('define() rejects invalid sampling', () => {
    expect(() =>
      RunConfig.define({
        name: 'bad-samp',
        runs: [{ dataset: ds, evaluators: [ev], sampling: { count: 1, percent: 1 } }],
      }),
    ).toThrow(/only one of count or percent/);
    expect(() =>
      RunConfig.define({
        name: 'bad-samp-2',
        runs: [{ dataset: ds, evaluators: [ev], sampling: { count: -1 } }],
      }),
    ).toThrow(/sampling.count/);
    expect(() =>
      RunConfig.define({
        name: 'bad-samp-3',
        runs: [{ dataset: ds, evaluators: [ev], sampling: { percent: 101 } }],
      }),
    ).toThrow(/sampling.percent/);
  });
});
