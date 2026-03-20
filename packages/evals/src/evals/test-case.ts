import type { Schema as S } from 'effect';
import {
  normalizeOptionalDisplayName,
  type TestCaseName,
  validateTestCaseName,
} from './entity-name';

type InputOrBuilder<T> = T | (() => T);

interface TestCaseConfig<TInput, TOutput> {
  name: TestCaseName;
  displayName?: string;
  tags: string[];
  inputSchema: S.Schema.Any;
  input: InputOrBuilder<TInput>;
  outputSchema?: S.Schema.Any;
  output?: InputOrBuilder<TOutput>;
}

interface TestCaseDescribeConfig<
  TI extends S.Schema.Any,
  TO extends S.Schema.Any = S.Schema<unknown>,
> {
  /**
   * Stable id (letters, digits, `_`, `-`); used in discovery and matching.
   * For an unrestricted UI label, set {@link displayName}.
   */
  name: string;
  /** Optional human-readable label for CLI/TUI and evaluator args (any characters). */
  displayName?: string;
  /**
   * Declared tags on this test case (not `Dataset` filter options). Use `Dataset` `includedTags` /
   * `excludedTags` to select which cases belong to a dataset; evaluators read the resolved tags as
   * `meta.testCaseTags`.
   */
  tags?: ReadonlyArray<string>;
  inputSchema: TI;
  input: InputOrBuilder<S.Schema.Type<TI>>;
  outputSchema?: TO;
  output?: InputOrBuilder<S.Schema.Type<TO>>;
}

function resolve<T>(value: InputOrBuilder<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export class TestCase<TInput = unknown, TOutput = unknown> {
  private readonly _config: TestCaseConfig<TInput, TOutput>;

  private constructor(config: TestCaseConfig<TInput, TOutput>) {
    this._config = config;
  }

  static describe<TI extends S.Schema.Any, TO extends S.Schema.Any = S.Schema<unknown>>(
    config: TestCaseDescribeConfig<TI, TO>,
  ): TestCase<S.Schema.Type<TI>, S.Schema.Type<TO>> {
    const name = validateTestCaseName(config.name, 'TestCase.describe');
    const displayName = normalizeOptionalDisplayName(config.displayName);
    const tags = config.tags !== undefined ? [...config.tags] : [];
    return new TestCase<S.Schema.Type<TI>, S.Schema.Type<TO>>({
      name,
      displayName,
      tags,
      inputSchema: config.inputSchema,
      input: config.input,
      outputSchema: config.outputSchema,
      output: config.output,
    });
  }

  getName(): string {
    return this._config.name;
  }

  getDisplayName(): string | undefined {
    return this._config.displayName;
  }

  getDisplayLabel(): string {
    return this._config.displayName ?? this._config.name;
  }

  getTags(): string[] {
    return [...this._config.tags];
  }

  getInputSchema(): S.Schema.Any {
    return this._config.inputSchema;
  }

  getInput(): TInput {
    return resolve(this._config.input);
  }

  getOutputSchema(): S.Schema.Any | undefined {
    return this._config.outputSchema;
  }

  getOutput(): TOutput | undefined {
    if (this._config.output === undefined) {
      return undefined;
    }
    return resolve(this._config.output);
  }
}

/** CLI-friendly label: {@link TestCase.getDisplayLabel} when present, else {@link TestCase.getName} (supports plain test-case-shaped objects). */
export function getTestCaseDisplayLabel(testCase: {
  getDisplayLabel?: () => string;
  getName?: () => string;
}): string {
  if (typeof testCase.getDisplayLabel === 'function') {
    return testCase.getDisplayLabel();
  }
  return typeof testCase.getName === 'function' ? testCase.getName() : '';
}

/** Tags for evaluator `meta.testCaseTags` (supports plain test-case-shaped objects without `getTags`). */
export function getTestCaseTagList(testCase: { getTags?: () => ReadonlyArray<string> }): string[] {
  return typeof testCase.getTags === 'function' ? [...testCase.getTags()] : [];
}
