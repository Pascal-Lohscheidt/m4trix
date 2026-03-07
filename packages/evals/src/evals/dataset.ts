import type { TagMatcher, PathMatcher } from './types';
import type { TestCase } from './test-case';

interface DatasetConfig {
  name: string;
  includedTags: ReadonlyArray<TagMatcher>;
  excludedTags: ReadonlyArray<TagMatcher>;
  includedPaths: ReadonlyArray<PathMatcher>;
  excludedPaths: ReadonlyArray<PathMatcher>;
}

interface DatasetDefineConfig {
  name: string;
  includedTags?: TagMatcher[];
  excludedTags?: TagMatcher[];
  includedPaths?: PathMatcher[];
  excludedPaths?: PathMatcher[];
}

function matchesAny(
  value: string,
  matchers: ReadonlyArray<string | RegExp>,
): boolean {
  return matchers.some((matcher) =>
    typeof matcher === 'string' ? value === matcher : matcher.test(value),
  );
}

function matchesAnyPath(
  filePath: string,
  matchers: ReadonlyArray<string | RegExp>,
): boolean {
  return matchers.some((matcher) => {
    if (typeof matcher === 'string') {
      return simpleGlobMatch(matcher, filePath);
    }
    return matcher.test(filePath);
  });
}

function simpleGlobMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '[^/]')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(value);
}

export class Dataset {
  private readonly _config: DatasetConfig;

  private constructor(config: DatasetConfig) {
    this._config = config;
  }

  static define(config: DatasetDefineConfig): Dataset {
    return new Dataset({
      name: config.name,
      includedTags: config.includedTags ?? [],
      excludedTags: config.excludedTags ?? [],
      includedPaths: config.includedPaths ?? [],
      excludedPaths: config.excludedPaths ?? [],
    });
  }

  getName(): string {
    return this._config.name;
  }

  getIncludedTags(): ReadonlyArray<TagMatcher> {
    return this._config.includedTags;
  }

  getExcludedTags(): ReadonlyArray<TagMatcher> {
    return this._config.excludedTags;
  }

  getIncludedPaths(): ReadonlyArray<PathMatcher> {
    return this._config.includedPaths;
  }

  getExcludedPaths(): ReadonlyArray<PathMatcher> {
    return this._config.excludedPaths;
  }

  matchesTestCase(
    testCase: TestCase<unknown>,
    filePath: string,
  ): boolean {
    const tags = testCase.getTags();

    if (this._config.excludedTags.length > 0) {
      if (tags.some((tag) => matchesAny(tag, this._config.excludedTags))) {
        return false;
      }
    }

    if (this._config.excludedPaths.length > 0) {
      if (matchesAnyPath(filePath, this._config.excludedPaths)) {
        return false;
      }
    }

    const tagMatch =
      this._config.includedTags.length === 0 ||
      tags.some((tag) => matchesAny(tag, this._config.includedTags));

    const pathMatch =
      this._config.includedPaths.length === 0 ||
      matchesAnyPath(filePath, this._config.includedPaths);

    return tagMatch && pathMatch;
  }
}
