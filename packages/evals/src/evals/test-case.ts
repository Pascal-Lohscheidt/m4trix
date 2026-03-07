import { Schema as S } from 'effect';

type InputOrBuilder<T> = T | (() => T);

interface TestCaseConfig<TInput, TOutput> {
  name: string;
  tags: string[];
  reruns: number;
  inputSchema: S.Schema.Any;
  input: InputOrBuilder<TInput>;
  outputSchema?: S.Schema.Any;
  output?: InputOrBuilder<TOutput>;
}

interface TestCaseDescribeConfig<
  TI extends S.Schema.Any,
  TO extends S.Schema.Any = S.Schema<unknown>,
> {
  name: string;
  tags: string[];
  reruns?: number;
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
    const reruns = config.reruns ?? 1;
    if (reruns < 1 || !Number.isInteger(reruns)) {
      throw new Error(`TestCase reruns must be a positive integer, got ${reruns}`);
    }
    return new TestCase<S.Schema.Type<TI>, S.Schema.Type<TO>>({
      name: config.name,
      tags: config.tags,
      reruns,
      inputSchema: config.inputSchema,
      input: config.input,
      outputSchema: config.outputSchema,
      output: config.output,
    });
  }

  getReruns(): number {
    return this._config.reruns;
  }

  getName(): string {
    return this._config.name;
  }

  getTags(): string[] {
    return this._config.tags;
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
