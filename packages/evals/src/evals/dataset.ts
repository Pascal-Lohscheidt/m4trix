import { type DatasetName, normalizeOptionalDisplayName, validateDatasetName } from './entity-name';
import { evaluateTagFilter } from './evaluate-tag-filter';
import type { TagOrFilterExpression } from './tag-filter';
import type { TestCase } from './test-case';
import type { PathMatcher, TagMatcher } from './types';

/** `Dataset.define({ includedTags })`: legacy flat matchers or a structured {@link TagOrFilterExpression} tree. */
export type DatasetIncludedTags = ReadonlyArray<TagMatcher> | TagOrFilterExpression;

interface DatasetConfig {
  name: DatasetName;
  displayName?: string;
  includedTags: DatasetIncludedTags;
  excludedTags: ReadonlyArray<TagMatcher>;
  includedPaths: ReadonlyArray<PathMatcher>;
  excludedPaths: ReadonlyArray<PathMatcher>;
}

export interface DatasetDefineConfig {
  /**
   * Stable id (letters, digits, `_`, `-`); used for discovery ids and `resolveDatasetByName`.
   * For an unrestricted UI label, set {@link displayName}.
   */
  name: string;
  /** Optional human-readable label for CLI/TUI (any characters). */
  displayName?: string;
  includedTags?: DatasetIncludedTags;
  excludedTags?: TagMatcher[];
  includedPaths?: PathMatcher[];
  excludedPaths?: PathMatcher[];
}

function matchesAny(value: string, matchers: ReadonlyArray<string | RegExp>): boolean {
  return matchers.some((matcher) =>
    typeof matcher === 'string' ? value === matcher : matcher.test(value),
  );
}

function isStructuredIncludedTags(included: DatasetIncludedTags): included is TagOrFilterExpression {
  return !Array.isArray(included);
}

function matchesIncludedTags(tags: ReadonlyArray<string>, included: DatasetIncludedTags): boolean {
  if (isStructuredIncludedTags(included)) {
    return evaluateTagFilter(tags, included);
  }
  return included.length === 0 || tags.some((tag) => matchesAny(tag, included));
}

function matchesAnyPath(filePath: string, matchers: ReadonlyArray<string | RegExp>): boolean {
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
    const name = validateDatasetName(config.name, 'Dataset.define');
    const displayName = normalizeOptionalDisplayName(config.displayName);
    return new Dataset({
      name,
      displayName,
      includedTags: config.includedTags ?? [],
      excludedTags: config.excludedTags ?? [],
      includedPaths: config.includedPaths ?? [],
      excludedPaths: config.excludedPaths ?? [],
    });
  }

  /** Canonical dataset id (same rules as `RunConfig` / `TestCase` `name`). */
  getName(): string {
    return this._config.name;
  }

  getDisplayName(): string | undefined {
    return this._config.displayName;
  }

  /** Label for CLI/TUI and evaluator `meta.datasetName`: {@link getDisplayName} if set, otherwise {@link getName}. */
  getDisplayLabel(): string {
    return this._config.displayName ?? this._config.name;
  }

  getIncludedTags(): DatasetIncludedTags {
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

  matchesTestCase(testCase: TestCase<unknown>, filePath: string): boolean {
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

    const tagMatch = matchesIncludedTags(tags, this._config.includedTags);

    const pathMatch =
      this._config.includedPaths.length === 0 ||
      matchesAnyPath(filePath, this._config.includedPaths);

    return tagMatch && pathMatch;
  }
}

/** CLI / runner: display label for a dataset-shaped object (supports discovery duck-types). */
export function getDatasetDisplayLabel(dataset: {
  getDisplayLabel?: () => string;
  getName?: () => string;
}): string {
  if (typeof dataset.getDisplayLabel === 'function') {
    return dataset.getDisplayLabel();
  }
  return typeof dataset.getName === 'function' ? dataset.getName() : '';
}
