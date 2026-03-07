import { describe, expect, test } from 'vitest';
import { Schema as S } from 'effect';
import { Dataset } from './dataset';
import { TestCase } from './test-case';

function makeTestCase(tags: string[]) {
  return TestCase.describe({
    name: `test-${tags.join('-')}`,
    tags,
    inputSchema: S.Struct({ x: S.String }),
    input: { x: 'a' },
  });
}

describe('Dataset', () => {
  test('define() creates a Dataset with name and empty filters', () => {
    const ds = Dataset.define({ name: 'all-tests' });

    expect(ds.getName()).toBe('all-tests');
    expect(ds.getIncludedTags()).toEqual([]);
    expect(ds.getExcludedTags()).toEqual([]);
    expect(ds.getIncludedPaths()).toEqual([]);
    expect(ds.getExcludedPaths()).toEqual([]);
  });

  test('matchesTestCase returns true when no filters are set', () => {
    const ds = Dataset.define({ name: 'empty-filters' });
    const tc = makeTestCase(['agent', 'title']);

    expect(ds.matchesTestCase(tc, 'src/tests/agent.test-case.ts')).toBe(true);
  });

  test('includedTags filters by exact string match', () => {
    const ds = Dataset.define({
      name: 'agents-only',
      includedTags: ['agent'],
    });

    expect(ds.matchesTestCase(makeTestCase(['agent', 'fast']), 'a.ts')).toBe(
      true,
    );
    expect(ds.matchesTestCase(makeTestCase(['slow']), 'a.ts')).toBe(false);
  });

  test('includedTags filters by regex match', () => {
    const ds = Dataset.define({
      name: 'regex-tags',
      includedTags: [/^agent-/],
    });

    expect(ds.matchesTestCase(makeTestCase(['agent-v2']), 'a.ts')).toBe(true);
    expect(ds.matchesTestCase(makeTestCase(['agent']), 'a.ts')).toBe(false);
  });

  test('excludedTags removes matching test cases', () => {
    const ds = Dataset.define({
      name: 'no-slow',
      excludedTags: ['slow'],
    });

    expect(ds.matchesTestCase(makeTestCase(['agent', 'slow']), 'a.ts')).toBe(
      false,
    );
    expect(ds.matchesTestCase(makeTestCase(['agent', 'fast']), 'a.ts')).toBe(
      true,
    );
  });

  test('excludedTags takes precedence over includedTags', () => {
    const ds = Dataset.define({
      name: 'include-but-exclude',
      includedTags: ['agent'],
      excludedTags: ['agent'],
    });

    expect(ds.matchesTestCase(makeTestCase(['agent']), 'a.ts')).toBe(false);
  });

  test('includedPaths filters by glob pattern', () => {
    const ds = Dataset.define({
      name: 'src-only',
      includedPaths: ['src/**/*.test-case.ts'],
    });

    expect(
      ds.matchesTestCase(makeTestCase([]), 'src/agents/title.test-case.ts'),
    ).toBe(true);
    expect(ds.matchesTestCase(makeTestCase([]), 'lib/other.test-case.ts')).toBe(
      false,
    );
  });

  test('includedPaths filters by regex', () => {
    const ds = Dataset.define({
      name: 'regex-paths',
      includedPaths: [/\/agents\//],
    });

    expect(
      ds.matchesTestCase(makeTestCase([]), 'src/agents/title.test-case.ts'),
    ).toBe(true);
    expect(
      ds.matchesTestCase(makeTestCase([]), 'src/utils/helper.test-case.ts'),
    ).toBe(false);
  });

  test('excludedPaths removes matching file paths', () => {
    const ds = Dataset.define({
      name: 'no-fixtures',
      excludedPaths: [/fixtures/],
    });

    expect(
      ds.matchesTestCase(makeTestCase([]), 'src/fixtures/broken.test-case.ts'),
    ).toBe(false);
    expect(
      ds.matchesTestCase(makeTestCase([]), 'src/agents/good.test-case.ts'),
    ).toBe(true);
  });

  test('combined tag and path filters (AND logic)', () => {
    const ds = Dataset.define({
      name: 'combined',
      includedTags: ['agent'],
      includedPaths: ['src/**/*.test-case.ts'],
    });

    expect(
      ds.matchesTestCase(makeTestCase(['agent']), 'src/foo.test-case.ts'),
    ).toBe(true);
    expect(
      ds.matchesTestCase(makeTestCase(['other']), 'src/foo.test-case.ts'),
    ).toBe(false);
    expect(
      ds.matchesTestCase(makeTestCase(['agent']), 'lib/foo.test-case.ts'),
    ).toBe(false);
  });

  test('returns an immutable Dataset instance', () => {
    const ds = Dataset.define({ name: 'immutable' });
    expect(ds).toBeInstanceOf(Dataset);
  });

  test('matchesTestCase accepts TestCase with any input types', () => {
    const tc = TestCase.describe({
      name: 'any',
      tags: ['a'],
      inputSchema: S.Struct({ x: S.String }),
      input: { x: 'a' },
    });
    const ds = Dataset.define({ name: 'd', includedTags: ['a'] });
    const result: boolean = ds.matchesTestCase(tc, 'path/to/file.ts');
    expect(result).toBe(true);
  });
});
