import type { Schema as S } from 'effect';
import type { CreateDiffLogEntryOptions } from './diff';
import {
  type EvaluatorName,
  normalizeOptionalDisplayName,
  validateEvaluatorName,
} from './entity-name';

export interface EvalMiddleware<TCtx> {
  name: string;
  resolve: () => TCtx | Promise<TCtx>;
}

export interface EvaluateMeta {
  /** Identifier of the trigger that started the run (for example, a CLI invocation). */
  triggerId: string;
  /**
   * Identifier of the current test-case execution shared across all evaluators
   * for this specific test-case run.
   */
  runId: string;
  /** Display label for the dataset (`Dataset.getDisplayLabel()`, i.e. `displayName ?? name`). */
  datasetName: string;
  /** Canonical `RunConfig` name (or `programmatic` for API/TUI-only runs). */
  runConfigName: string;
  /**
   * Stable id shared by every execution of the same logical test case when `repetitionCount > 1`
   * (and present with count 1 for consistency).
   */
  repetitionId: string;
  /** 1-based index of this execution within the repetition group. */
  repetitionIndex: number;
  /** Total scheduled executions for this logical test case in the current run. */
  repetitionCount: number;
}

export interface EvaluateArgs<TInput, TOutput = unknown, TCtx = Record<string, never>> {
  input: TInput;
  ctx: TCtx;
  output?: TOutput;
  /** Metadata about the current evaluator invocation. */
  meta: EvaluateMeta;
  /** Tags from `TestCase.describe({ tags })` for the current test case. */
  testCaseTags: string[];
  /** Tags from `RunConfig.define({ tags })` for this job; empty for programmatic runs unless set on the request. */
  runConfigTags: string[];
  /** Tags from `Evaluator.define({ tags })` for this evaluator. */
  evaluatorTags: string[];
  /** Records a diff for this test case; stored in run artifact and shown by CLI */
  logDiff: (expected: unknown, actual: unknown, options?: CreateDiffLogEntryOptions) => void;
  /** Logs a message or object for this test case; stored in run artifact and shown by CLI */
  log: (message: unknown, options?: { label?: string }) => void;
  /**
   * Creates an Error from string/object payloads for `return createError(...)` (or `throw createError(...)`).
   * The payload is also logged and shown by the CLI when the evaluator fails.
   */
  createError: (message: unknown, options?: { label?: string }) => Error;
}

type EvaluateFn<TInput, TOutput, TScore, TCtx> = (
  args: EvaluateArgs<TInput, TOutput, TCtx>,
) => TScore | Error | Promise<TScore | Error>;

interface EvaluatorConfig<TInput, TOutput, TScore, TCtx> {
  name?: EvaluatorName;
  displayName?: string;
  tags: readonly string[];
  inputSchema?: S.Schema.Any;
  outputSchema?: S.Schema.Any;
  scoreSchema?: S.Schema.Any;
  middlewares: ReadonlyArray<EvalMiddleware<unknown>>;
  evaluateFn?: EvaluateFn<TInput, TOutput, TScore, TCtx>;
  passThreshold?: number;
  passCriterion?: (score: unknown) => boolean;
  /** Phantom field for TOutput type parameter */
  _outputType?: TOutput;
}

interface EvaluatorDefineConfig<
  TI extends S.Schema.Any,
  TO extends S.Schema.Any,
  TS extends S.Schema.Any,
> {
  /**
   * Stable id (letters, digits, `_`, `-`); used for discovery, name patterns, and `meta`.
   * For an unrestricted UI label, set {@link displayName}.
   */
  name: string;
  /** Optional human-readable label for CLI/TUI (any characters). */
  displayName?: string;
  inputSchema: TI;
  outputSchema: TO;
  scoreSchema: TS;
  passThreshold?: number;
  passCriterion?: (score: unknown) => boolean;
  /** Optional tags for this evaluator; surfaced on every `evaluate` invocation. */
  tags?: ReadonlyArray<string>;
}

export class Evaluator<
  TInput = unknown,
  TOutput = unknown,
  TScore = unknown,
  TCtx = Record<string, never>,
> {
  private readonly _config: EvaluatorConfig<TInput, TOutput, TScore, TCtx>;

  private constructor(config: EvaluatorConfig<TInput, TOutput, TScore, TCtx>) {
    this._config = config;
  }

  private getState(): EvaluatorConfig<TInput, TOutput, TScore, TCtx> {
    return {
      name: this._config.name,
      displayName: this._config.displayName,
      tags: this._config.tags,
      inputSchema: this._config.inputSchema,
      outputSchema: this._config.outputSchema,
      scoreSchema: this._config.scoreSchema,
      middlewares: this._config.middlewares,
      evaluateFn: this._config.evaluateFn,
      passThreshold: this._config.passThreshold,
      passCriterion: this._config.passCriterion,
    };
  }

  static use<TCtx>(middleware: EvalMiddleware<TCtx>): Evaluator<unknown, unknown, unknown, TCtx> {
    return new Evaluator<unknown, unknown, unknown, TCtx>({
      middlewares: [middleware as EvalMiddleware<unknown>],
      tags: [],
    });
  }

  use<TNew>(middleware: EvalMiddleware<TNew>): Evaluator<TInput, TOutput, TScore, TCtx & TNew> {
    const state = this.getState();
    return new Evaluator<TInput, TOutput, TScore, TCtx & TNew>({
      ...(state as unknown as EvaluatorConfig<TInput, TOutput, TScore, TCtx & TNew>),
      middlewares: [...state.middlewares, middleware as EvalMiddleware<unknown>],
    });
  }

  define<TI extends S.Schema.Any, TO extends S.Schema.Any, TS extends S.Schema.Any>(
    config: EvaluatorDefineConfig<TI, TO, TS>,
  ): Evaluator<S.Schema.Type<TI>, S.Schema.Type<TO>, S.Schema.Type<TS>, TCtx> {
    const { middlewares } = this.getState();
    const name = validateEvaluatorName(config.name, 'Evaluator.define');
    const displayName = normalizeOptionalDisplayName(config.displayName);
    const tags = config.tags !== undefined ? [...config.tags] : [];
    return new Evaluator<S.Schema.Type<TI>, S.Schema.Type<TO>, S.Schema.Type<TS>, TCtx>({
      name,
      displayName,
      tags,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      scoreSchema: config.scoreSchema,
      middlewares,
      passThreshold: config.passThreshold,
      passCriterion: config.passCriterion,
    });
  }

  evaluate(
    fn: EvaluateFn<TInput, TOutput, TScore, TCtx>,
  ): Evaluator<TInput, TOutput, TScore, TCtx> {
    return new Evaluator<TInput, TOutput, TScore, TCtx>({
      ...this.getState(),
      evaluateFn: fn,
    });
  }

  /** Canonical evaluator id when defined; otherwise undefined (middleware-only chain). */
  getName(): string | undefined {
    return this._config.name;
  }

  getDisplayName(): string | undefined {
    return this._config.displayName;
  }

  /** Label for CLI/TUI: {@link getDisplayName} if set, otherwise {@link getName}. Undefined if not yet defined. */
  getDisplayLabel(): string | undefined {
    const id = this._config.name;
    if (id === undefined) {
      return undefined;
    }
    return this._config.displayName ?? id;
  }

  /** Tags from `Evaluator.define({ tags })`; empty until defined. */
  getTags(): string[] {
    return [...this._config.tags];
  }

  getInputSchema(): S.Schema.Any | undefined {
    return this._config.inputSchema;
  }

  getOutputSchema(): S.Schema.Any | undefined {
    return this._config.outputSchema;
  }

  getScoreSchema(): S.Schema.Any | undefined {
    return this._config.scoreSchema;
  }

  getMiddlewares(): ReadonlyArray<EvalMiddleware<unknown>> {
    return this._config.middlewares;
  }

  getEvaluateFn(): EvaluateFn<TInput, TOutput, TScore, TCtx> | undefined {
    return this._config.evaluateFn;
  }

  getPassThreshold(): number | undefined {
    return this._config.passThreshold;
  }

  getPassCriterion(): ((score: unknown) => boolean) | undefined {
    return this._config.passCriterion;
  }

  async resolveContext(): Promise<TCtx> {
    const parts = await Promise.all(this._config.middlewares.map((mw) => mw.resolve()));
    return Object.assign({}, ...parts) as TCtx;
  }
}

/** CLI-friendly label: {@link Evaluator.getDisplayLabel} when present, else {@link Evaluator.getName} (supports plain evaluator-shaped objects from discovery). */
export function getEvaluatorDisplayLabel(evaluator: {
  getDisplayLabel?: () => string | undefined;
  getName?: () => string | undefined;
}): string | undefined {
  if (typeof evaluator.getDisplayLabel === 'function') {
    const label = evaluator.getDisplayLabel();
    if (label !== undefined) {
      return label;
    }
  }
  return typeof evaluator.getName === 'function' ? evaluator.getName() : undefined;
}

/** Tags for evaluator `args.evaluatorTags` (plain evaluator-shaped objects without `getTags` yield `[]`). */
export function getEvaluatorTagList(evaluator: {
  getTags?: () => ReadonlyArray<string>;
}): string[] {
  return typeof evaluator.getTags === 'function' ? [...evaluator.getTags()] : [];
}
