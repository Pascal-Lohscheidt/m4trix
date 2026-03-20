import { Either, ParseResult, Schema } from 'effect';

const ENTITY_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function makeEntityIdSchema<const B extends string>(brand: B, label: string) {
  return Schema.String.pipe(
    Schema.trimmed(),
    Schema.minLength(1, {
      message: () => `${label} must be non-empty.`,
    }),
    Schema.pattern(ENTITY_ID_PATTERN, {
      message: () =>
        `${label} may only contain letters, digits, underscores, and hyphens (no spaces). Examples: "my-nightly", "my_nightly", "myNightly".`,
    }),
    Schema.brand(brand),
  );
}

/** Branded id for `RunConfig` `name` (decode with {@link RunConfigNameSchema}). */
export const RunConfigNameSchema = makeEntityIdSchema('RunConfigName', 'RunConfig name');

/** Branded id for `Evaluator.define({ name })` (decode with {@link EvaluatorNameSchema}). */
export const EvaluatorNameSchema = makeEntityIdSchema('EvaluatorName', 'Evaluator name');

/** Branded id for `TestCase.describe({ name })` (decode with {@link TestCaseNameSchema}). */
export const TestCaseNameSchema = makeEntityIdSchema('TestCaseName', 'Test case name');

/** Branded id for `Dataset.define({ name })` (decode with {@link DatasetNameSchema}). */
export const DatasetNameSchema = makeEntityIdSchema('DatasetName', 'Dataset name');

export type RunConfigName = Schema.Schema.Type<typeof RunConfigNameSchema>;
export type EvaluatorName = Schema.Schema.Type<typeof EvaluatorNameSchema>;
export type TestCaseName = Schema.Schema.Type<typeof TestCaseNameSchema>;
export type DatasetName = Schema.Schema.Type<typeof DatasetNameSchema>;

function validateWithSchema(schema: Schema.Schema.Any, raw: string, context: string): unknown {
  const trimmed = raw.trim();
  // Branded string schemas use `Context = unknown`; `decodeUnknownEither` is typed for context `never`.
  const decode = Schema.decodeUnknownEither(
    schema as unknown as Schema.Schema<string, string, never>,
  );
  const result = decode(trimmed);
  if (Either.isLeft(result)) {
    throw new Error(`${context}: ${ParseResult.TreeFormatter.formatErrorSync(result.left)}`);
  }
  return result.right;
}

export function validateRunConfigName(raw: string, context: string): RunConfigName {
  return validateWithSchema(RunConfigNameSchema, raw, context) as RunConfigName;
}

export function validateEvaluatorName(raw: string, context: string): EvaluatorName {
  return validateWithSchema(EvaluatorNameSchema, raw, context) as EvaluatorName;
}

export function validateTestCaseName(raw: string, context: string): TestCaseName {
  return validateWithSchema(TestCaseNameSchema, raw, context) as TestCaseName;
}

export function validateDatasetName(raw: string, context: string): DatasetName {
  return validateWithSchema(DatasetNameSchema, raw, context) as DatasetName;
}

/** Optional UI label: trim; empty after trim becomes undefined. */
export function normalizeOptionalDisplayName(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const t = raw.trim();
  return t.length === 0 ? undefined : t;
}
