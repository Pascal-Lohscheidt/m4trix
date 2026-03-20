import { Either, ParseResult, Schema } from 'effect';

import type { Dataset } from './dataset';
import type { Evaluator } from './evaluator';

/**
 * Schema for a validated RunConfig identifier: trimmed, non-empty, letters / digits / `_` / `-` only
 * (kebab-case, snake_case, camelCase, etc.). See {@link https://effect.website/docs/schema/advanced-usage/#branded-types Effect Schema brands}.
 */
export const RunConfigNameSchema = Schema.String.pipe(
  Schema.trimmed(),
  Schema.minLength(1, {
    message: () => 'RunConfig name must be non-empty.',
  }),
  Schema.pattern(/^[a-zA-Z0-9_-]+$/, {
    message: () =>
      'RunConfig name may only contain letters, digits, underscores, and hyphens (no spaces). Examples: "my-nightly", "my_nightly", "myNightly".',
  }),
  Schema.brand('RunConfigName'),
);

/** Branded string for a validated RunConfig `name` (decode with {@link RunConfigNameSchema}). */
export type RunConfigName = Schema.Schema.Type<typeof RunConfigNameSchema>;

/**
 * Trims, validates, and returns a branded RunConfig name.
 * Use at define-time, when resolving CLI/API names, and when starting `runDatasetWith`.
 */
export function validateRunConfigName(raw: string, context: string): RunConfigName {
  const trimmed = raw.trim();
  const result = Schema.decodeUnknownEither(RunConfigNameSchema)(trimmed);
  if (Either.isLeft(result)) {
    throw new Error(`${context}: ${ParseResult.TreeFormatter.formatErrorSync(result.left)}`);
  }
  return result.right;
}

/** Heterogeneous evaluator rows; `unknown` breaks assignability from concrete `EvaluateFn` (contravariance on `input`). */
// biome-ignore lint/suspicious/noExplicitAny: needs to accept every `Evaluator<...>` in one array
export type RunConfigEvaluatorRef = Evaluator<any, any, any, any>;

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
}

/** Select evaluators using the same wildcard / regex rules as the runner's `resolveEvaluatorsByNamePattern`. */
export interface RunConfigRowPattern {
  readonly dataset: Dataset;
  readonly evaluatorPattern: string;
  readonly evaluators?: undefined;
  readonly repetitions?: number;
}

export type RunConfigRow = RunConfigRowEvaluators | RunConfigRowPattern;

export interface RunConfigDefineConfig {
  /** Plain string in user config; parsed into {@link RunConfigName} via {@link RunConfigNameSchema} inside {@link RunConfig.define}. */
  name: string;
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
    throw new Error(
      `RunConfig run[${index}] must not set both evaluators and evaluatorPattern`,
    );
  }
  if (!hasEvaluators && !hasPattern) {
    throw new Error(
      `RunConfig run[${index}] must set either evaluators or evaluatorPattern`,
    );
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
}

export class RunConfig {
  private readonly _name: RunConfigName;
  private readonly _runs: ReadonlyArray<RunConfigRow>;

  private constructor(name: RunConfigName, runs: ReadonlyArray<RunConfigRow>) {
    this._name = name;
    this._runs = runs;
  }

  static define(config: RunConfigDefineConfig): RunConfig {
    if (config.runs.length === 0) {
      throw new Error('RunConfig runs must be non-empty');
    }
    config.runs.forEach(validateRow);
    const name = validateRunConfigName(config.name, 'RunConfig.define');
    return new RunConfig(name, config.runs);
  }

  /** Canonical name (validated {@link RunConfigName} at runtime; typed as `string` for ergonomics). */
  getName(): string {
    return this._name;
  }

  getRuns(): ReadonlyArray<RunConfigRow> {
    return this._runs;
  }
}
