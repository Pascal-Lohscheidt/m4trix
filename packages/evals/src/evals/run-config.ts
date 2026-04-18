import type { Dataset } from './dataset.js';
import {
  normalizeOptionalDisplayName,
  type RunConfigName,
  validateRunConfigName,
} from './entity-name.js';
import type { Evaluator } from './evaluator.js';

export type { RunConfigName } from './entity-name.js';
export { RunConfigNameSchema, validateRunConfigName } from './entity-name.js';

/** Heterogeneous evaluator rows; `unknown` breaks assignability from concrete `EvaluateFn` (contravariance on `input`). */
// biome-ignore lint/suspicious/noExplicitAny: needs to accept every `Evaluator<...>` in one array
export type RunConfigEvaluatorRef = Evaluator<any, any, any, any>;

/**
 * Subsample test cases for a run row. Omit the object or omit both `count` and `percent` to use the full dataset.
 *
 * Set exactly one of **`count`** (fixed size) or **`percent`** (0–100 of the matching test cases).
 * **`seed`** fixes the random subset across runs; if omitted, each run uses a new random seed.
 */
export interface RunConfigSampling {
  /** Deterministic subsample when set. If omitted while `count` or `percent` is set, each run picks a new seed. */
  seed?: string;
  /** Number of test cases to include. Mutually exclusive with `percent`. */
  count?: number;
  /** Percent of dataset size to include (0–100). Mutually exclusive with `count`. */
  percent?: number;
}

/** Select evaluators by concrete instances (same module exports as discovery). */
export interface RunConfigRowEvaluators {
  readonly dataset: Dataset;
  readonly evaluators: ReadonlyArray<RunConfigEvaluatorRef>;
  readonly evaluatorPattern?: undefined;
  /**
   * How many times each test case in this dataset is evaluated for this row (default: 1).
   * All executions of the same logical test case share one `repetitionId` in evaluator `meta`.
   */
  readonly repetitions?: number;
  /** Optional random subsample of this dataset's test cases (per row). */
  readonly sampling?: RunConfigSampling;
}

/** Select evaluators using the same wildcard / regex rules as the runner's `resolveEvaluatorsByNamePattern`. */
export interface RunConfigRowPattern {
  readonly dataset: Dataset;
  readonly evaluatorPattern: string;
  readonly evaluators?: undefined;
  readonly repetitions?: number;
  readonly sampling?: RunConfigSampling;
}

export type RunConfigRow = RunConfigRowEvaluators | RunConfigRowPattern;

export interface RunConfigDefineConfig {
  /**
   * Stable id (letters, digits, `_`, `-`); surfaced in discovery, CLI `--run-config`, and evaluator `meta`.
   * For an unrestricted UI label, set {@link displayName}.
   */
  name: string;
  /** Optional human-readable label for CLI/TUI (any characters). */
  displayName?: string;
  /** Optional declared tags for this run config; copied to every evaluation as `meta.runConfigTags`. */
  tags?: ReadonlyArray<string>;
  runs: ReadonlyArray<RunConfigRow>;
}

function validateRow(row: RunConfigRow, index: number): void {
  const hasEvaluators =
    'evaluators' in row &&
    row.evaluators !== undefined &&
    (row as RunConfigRowEvaluators).evaluators !== undefined;
  const hasPattern =
    'evaluatorPattern' in row &&
    typeof (row as RunConfigRowPattern).evaluatorPattern === 'string' &&
    (row as RunConfigRowPattern).evaluatorPattern.trim().length > 0;

  if (hasEvaluators && hasPattern) {
    throw new Error(`RunConfig run[${index}] must not set both evaluators and evaluatorPattern`);
  }
  if (!hasEvaluators && !hasPattern) {
    throw new Error(`RunConfig run[${index}] must set either evaluators or evaluatorPattern`);
  }
  if (hasEvaluators && (row as RunConfigRowEvaluators).evaluators.length === 0) {
    throw new Error(`RunConfig run[${index}]: evaluators must be non-empty`);
  }

  const rawRep = 'repetitions' in row ? (row as { repetitions?: number }).repetitions : undefined;
  const repetitions = rawRep ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(
      `RunConfig run[${index}]: repetitions must be a positive integer, got ${String(rawRep)}`,
    );
  }

  validateSampling(row, index);
}

function validateSampling(row: RunConfigRow, index: number): void {
  const raw = 'sampling' in row ? row.sampling : undefined;
  if (raw === undefined) {
    return;
  }
  const count = raw.count;
  const percent = raw.percent;
  const hasCount = count !== undefined;
  const hasPercent = percent !== undefined;
  if (!hasCount && !hasPercent) {
    return;
  }
  if (hasCount && hasPercent) {
    throw new Error(`RunConfig run[${index}]: sampling must set only one of count or percent`);
  }
  if (hasCount) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(
        `RunConfig run[${index}]: sampling.count must be a non-negative integer, got ${String(count)}`,
      );
    }
  }
  if (hasPercent) {
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error(
        `RunConfig run[${index}]: sampling.percent must be between 0 and 100 inclusive, got ${String(percent)}`,
      );
    }
  }
}

export class RunConfig {
  private readonly _name: RunConfigName;
  private readonly _displayName: string | undefined;
  private readonly _tags: readonly string[];
  private readonly _runs: ReadonlyArray<RunConfigRow>;

  private constructor(
    name: RunConfigName,
    displayName: string | undefined,
    tags: readonly string[],
    runs: ReadonlyArray<RunConfigRow>,
  ) {
    this._name = name;
    this._displayName = displayName;
    this._tags = tags;
    this._runs = runs;
  }

  static define(config: RunConfigDefineConfig): RunConfig {
    if (config.runs.length === 0) {
      throw new Error('RunConfig runs must be non-empty');
    }
    config.runs.forEach(validateRow);
    const name = validateRunConfigName(config.name, 'RunConfig.define');
    const displayName = normalizeOptionalDisplayName(config.displayName);
    const tags = config.tags !== undefined ? [...config.tags] : [];
    return new RunConfig(name, displayName, tags, config.runs);
  }

  /** Canonical id (branded {@link RunConfigName} at runtime; typed as `string` for ergonomics). */
  getName(): string {
    return this._name;
  }

  /** Optional unrestricted display label. */
  getDisplayName(): string | undefined {
    return this._displayName;
  }

  /** Label for CLI/TUI: {@link getDisplayName} if set, otherwise {@link getName}. */
  getDisplayLabel(): string {
    return this._displayName ?? this._name;
  }

  /** Tags from `RunConfig.define({ tags })`; surfaced as `meta.runConfigTags` on evaluator callbacks. */
  getTags(): string[] {
    return [...this._tags];
  }

  getRuns(): ReadonlyArray<RunConfigRow> {
    return this._runs;
  }
}
