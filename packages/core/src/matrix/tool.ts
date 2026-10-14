import { Either, Schema as S } from 'effect';
import * as Duration from 'effect/Duration';
import type { EmitPayload, EmitsOptions } from './agent-factory.js';
import type { AgentNetworkEventDef } from './agent-network/agent-network-event.js';
import type { Envelope } from './agent-network/event-plane.js';
import {
  assertUniqueLayerNames,
  type DependencyLayerDef,
  type LayersFromDeps,
  toLayerArray,
} from './dependency-layer.js';
import type { Principal } from './principal.js';
import {
  describeCause,
  ToolDefinitionError,
  ToolExecutionError,
  ToolInputError,
  type ToolModelResult,
  ToolOutputError,
  ToolTimeoutError,
  toToolIssues,
  toToolModelError,
} from './tool-errors.js';
import {
  type AiSdkHelpers,
  type AiSdkTool,
  type AnthropicTool,
  deriveToolJsonSchema,
  type OpenAIFunctionTool,
  type ToolJsonSchema,
  toAiSdkTools,
  toAnthropicTools,
  toOpenAITools,
} from './tool-formatters.js';
import type { RunSpan, RunTraceScope } from './tracing/network-tracer.js';
import type { UsageReport, UsageReporter } from './usage.js';
import {
  type EmitValidationError,
  guardEmit,
  guardEmitAndAwait,
  isEmitValidationError,
} from './validation.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

export type ToolSchema<TInput = unknown, TOutput = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly input: S.Schema<TInput>;
  readonly output: S.Schema<TOutput>;
};

export type ToolEmitFn<TEvent = never> = (event: TEvent) => void;
export type ToolEmitAndAwaitFn<TEvent = never> = (
  event: TEvent,
  match: (reply: Envelope) => boolean,
  options?: { timeout?: Duration.DurationInput },
) => Promise<Envelope>;

export type ToolExecutionContext<TInput, TLayers, TEmits extends EventDef = never> = {
  readonly input: TInput;
  readonly layers: TLayers;
  /**
   * Publishes one of the tool's declared `emits` (payload decoded with its schema). Throws
   * `EmitValidationError` for anything else; inside an agent that fails the agent's invocation.
   */
  readonly emit: ToolEmitFn<EmitPayload<TEmits>>;
  readonly emitAndAwait: ToolEmitAndAwaitFn<EmitPayload<TEmits>>;
  readonly toolCallId: string;
  /** The calling agent's signal: aborted when its run ends. Never aborts for unbound use. */
  readonly signal: AbortSignal;
  /** Ends the calling agent's run as completed (e.g. a `final_answer` tool). No-op outside a run. */
  readonly complete: () => void;
  /**
   * Records what a model call made by the tool used on the calling agent's run (see the agent's
   * `reportUsage`), attributed to this tool call. No-op outside a run.
   */
  readonly reportUsage: (usage: UsageReport) => void;
  /** Who the calling agent's run acts for (from `auth`); `undefined` for anonymous runs. */
  readonly principal: Principal | undefined;
};

/** Run lifecycle controls an agent hands to the tools it binds. */
export type ToolRunControls = {
  readonly signal?: AbortSignal;
  readonly complete?: () => void;
  /** The invocation's trace scope: every tool call opens a `tool` span in it. */
  readonly tracing?: RunTraceScope;
  /** Records usage on the invocation's run. */
  readonly reportUsage?: UsageReporter;
  /** The run's principal, handed to every tool call. */
  readonly principal?: Principal;
  /** The calling agent, named on `EmitValidationError`s of the tools' emits. */
  readonly agentId?: string;
  /** Told about every invalid emit of the tools, so it fails the agent's invocation. */
  readonly onInvalidEmit?: (error: EmitValidationError) => void;
};

type ToolExecuteFn<TInput, TOutput, TLayers, TEmits extends EventDef> = (
  ctx: ToolExecutionContext<TInput, TLayers, TEmits>,
) => TOutput | Promise<TOutput>;

type ConstructorParams<
  TInput,
  TOutput,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>,
  TEmits extends EventDef,
> = {
  name: string;
  description: string;
  inputSchema?: S.Schema<TInput>;
  outputSchema?: S.Schema<TOutput>;
  layers: ReadonlyArray<TDeps>;
  emits: ReadonlyArray<TEmits>;
  /** Names of the `emits` declared with `{ reply: true }`. */
  replyEvents?: ReadonlyArray<string>;
  timeoutMs?: number;
  retry?: RetryPolicy;
};

/** Opt-in retries for a tool's execution errors (see `Tool#retry`). */
export type ToolRetryOptions = {
  /** Extra attempts after the first one fails. `0` disables retries. */
  readonly times: number;
  /**
   * Wait before retry `n` (1-based): `base * factor^(n - 1)`, capped at `max`. Without it,
   * retries start immediately.
   */
  readonly backoff?: {
    readonly base: Duration.DurationInput;
    /** Growth per retry; `1` waits `base` every time. Defaults to `2`. */
    readonly factor?: number;
    readonly max?: Duration.DurationInput;
  };
};

type RetryPolicy = { times: number; baseMs: number; factor: number; maxMs: number };

type AnyLayers = LayersFromDeps<DependencyLayerDef<string, unknown, S.Schema.Any>>;
type AnyToolEmitFn = ToolEmitFn<unknown>;
type AnyToolEmitAndAwaitFn = ToolEmitAndAwaitFn<unknown>;

type BindableTool = {
  bind(options: ToolBindOptions<AnyLayers, EventDef>): BoundTool;
};

/** Per-call options for a bound tool, e.g. from a provider's tool call. */
export type ToolExecuteOptions = {
  /** The provider's tool call id; a random id is generated when omitted. */
  readonly toolCallId?: string;
  /** Aborts this call only, in addition to the signal the tool was bound with. */
  readonly signal?: AbortSignal;
};

export type BoundTool<TInput = unknown, TOutput = unknown> = {
  readonly schema: ToolSchema<TInput, TOutput>;
  /** Provider-neutral JSON Schema of the tool (name, description, input parameters). */
  toJsonSchema(): ToolJsonSchema;
  /**
   * Runs the tool. Rejects with `ToolInputError`, `ToolExecutionError`, `ToolOutputError` or
   * `ToolTimeoutError`; when the call is cancelled (bound or per-call signal aborted) it rejects
   * with the signal's reason instead. An invalid emit of the tool rejects with the
   * `EmitValidationError` itself (never retried, never a model result).
   */
  execute(input: unknown, options?: ToolExecuteOptions): Promise<TOutput>;
  /**
   * Runs the tool and resolves with a result to hand back to the model, so it can correct its
   * arguments or try something else. Never rejects for tool failures; cancellation still
   * rejects with the signal's reason so the run stops.
   */
  executeForModel(input: unknown, options?: ToolExecuteOptions): Promise<ToolModelResult<TOutput>>;
};

export type ToolBindOptions<TLayers, TEmits extends EventDef = never> = {
  readonly layers: TLayers;
  readonly emit?: ToolEmitFn<EmitPayload<TEmits>>;
  readonly emitAndAwait?: ToolEmitAndAwaitFn<EmitPayload<TEmits>>;
  readonly signal?: AbortSignal;
  readonly complete?: () => void;
  /** When set, every call opens a `tool` span (raw input) and ends it with the output or error. */
  readonly tracing?: RunTraceScope;
  /** Receives the tool's `reportUsage()` calls, with the tool call as their source. */
  readonly reportUsage?: UsageReporter;
  /** The calling run's principal (`ctx.principal` of every call). */
  readonly principal?: Principal;
  /** The calling agent, named on `EmitValidationError`s of the tool's emits. */
  readonly agentId?: string;
  /**
   * Told about every invalid emit of the tool (`EmitValidationError`) before it is thrown, even
   * when the tool or its caller catches it.
   */
  readonly onInvalidEmit?: (error: EmitValidationError) => void;
};

export type ToolDefinition<
  TInput = unknown,
  TOutput = unknown,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
  TEmits extends EventDef = never,
> = {
  readonly schema: ToolSchema<TInput, TOutput>;
  readonly dependencyLayers: ReadonlyArray<TDeps>;
  readonly emitEvents: ReadonlyArray<TEmits>;
  /** Names of the `emitEvents` declared with `{ reply: true }` (see `EmitsOptions.reply`). */
  readonly replyEvents?: ReadonlyArray<string>;
  /** Provider-neutral JSON Schema of the tool (name, description, input parameters). */
  toJsonSchema(): ToolJsonSchema;
  bind(options: ToolBindOptions<LayersFromDeps<TDeps>, TEmits>): BoundTool<TInput, TOutput>;
};

export type AnyToolDefinition = ToolDefinition<
  S.Schema.Type<S.Schema.Any>,
  S.Schema.Type<S.Schema.Any>,
  DependencyLayerDef<string, unknown, S.Schema.Any>,
  EventDef
>;

export type ToolDeps<T> =
  T extends ToolDefinition<
    S.Schema.Type<S.Schema.Any>,
    S.Schema.Type<S.Schema.Any>,
    infer D,
    EventDef
  >
    ? D
    : never;

/**
 * Tool names every supported provider accepts: OpenAI allows `^[a-zA-Z0-9_-]{1,64}$`, Anthropic
 * the same characters up to 128, so the intersection is enforced.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function assertValidToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ToolDefinitionError(
      name,
      `Invalid tool name ${JSON.stringify(name)}: tool names must match ^[a-zA-Z0-9_-]{1,64}$ ` +
        '(letters, digits, underscores and dashes) so every LLM provider accepts them.',
    );
  }
}

/** A controller aborted (with the same reason) as soon as any of `signals` aborts. */
function followSignals(signals: ReadonlyArray<AbortSignal>): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = (): void => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => source.removeEventListener('abort', onAbort));
  }
  const dispose = (): void => {
    for (const cleanup of cleanups) cleanup();
  };
  return { controller, dispose };
}

/**
 * One signal aborted as soon as any of `signals` aborts; a single defined signal is returned
 * unchanged. `dispose()` detaches the listeners once the call is over.
 */
function linkAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 1) return { signal: defined[0] as AbortSignal, dispose: () => {} };
  const { controller, dispose } = followSignals(defined);
  return { signal: controller.signal, dispose };
}

/** Tracing must never fail a tool: a throwing tracer just means no span. */
function startToolSpan(
  tracing: RunTraceScope | undefined,
  toolName: string,
  input: unknown,
): RunSpan | undefined {
  try {
    return tracing?.startRun('tool', toolName, input);
  } catch {
    return undefined;
  }
}

async function endToolSpan(span: RunSpan | undefined, output: unknown, error?: unknown) {
  if (!span) return;
  try {
    await span.end(
      output,
      error === undefined || error instanceof Error ? error : new Error(describeCause(error)),
    );
  } catch {
    // A failing tracer must not fail the tool.
  }
}

function toMillis(duration: Duration.DurationInput): number {
  try {
    return Duration.toMillis(Duration.decode(duration));
  } catch {
    return Number.NaN;
  }
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs one attempt of a tool. Rejects with the run's abort reason when cancelled, with
 * `ToolTimeoutError` when `timeoutMs` elapses (aborting the attempt's own signal), and with
 * `ToolExecutionError` when the tool throws.
 */
async function runAttempt<TOutput>(
  toolName: string,
  run: (signal: AbortSignal) => TOutput | Promise<TOutput>,
  outer: AbortSignal,
  timeoutMs: number | undefined,
  attemptNumber: number,
): Promise<TOutput> {
  if (timeoutMs === undefined) {
    try {
      return await run(outer);
    } catch (cause) {
      // Cancellation is not a tool failure: let it stop the caller.
      if (outer.aborted) throw outer.reason;
      // An invalid emit is a contract violation of the agent's run, not a retryable tool error.
      if (isEmitValidationError(cause)) throw cause;
      throw new ToolExecutionError(toolName, cause, attemptNumber);
    }
  }
  // The attempt gets its own signal so a timeout aborts the tool without aborting the run.
  const attempt = followSignals([outer]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut: ToolTimeoutError | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = new ToolTimeoutError(toolName, timeoutMs);
        attempt.controller.abort(timedOut);
        reject(timedOut);
      }, timeoutMs);
    });
    return await Promise.race([
      Promise.resolve().then(() => run(attempt.controller.signal)),
      timeout,
    ]);
  } catch (cause) {
    if (outer.aborted) throw outer.reason;
    if (timedOut) throw timedOut;
    if (isEmitValidationError(cause)) throw cause;
    throw new ToolExecutionError(toolName, cause, attemptNumber);
  } finally {
    clearTimeout(timer);
    attempt.dispose();
  }
}

export function toToolArray<T extends AnyToolDefinition>(
  tools: [T, ...T[]] | [ReadonlyArray<T>],
): ReadonlyArray<T> {
  if (tools.length === 1 && Array.isArray(tools[0])) {
    return tools[0];
  }
  return [...(tools as [T, ...T[]])];
}

export class AgentToolCollection<
  TTools extends AnyToolDefinition = never,
  TAgentDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
  TAgentEmit = never,
> {
  readonly #definitions: ReadonlyArray<TTools>;
  readonly #layers: LayersFromDeps<TAgentDeps>;
  readonly #emit: ToolEmitFn<TAgentEmit>;
  readonly #emitAndAwait: ToolEmitAndAwaitFn<TAgentEmit>;
  readonly #runControls: ToolRunControls;

  constructor(
    definitions: ReadonlyArray<TTools>,
    layers: LayersFromDeps<TAgentDeps>,
    emit: ToolEmitFn<TAgentEmit>,
    emitAndAwait: ToolEmitAndAwaitFn<TAgentEmit> = async () => {
      throw new Error('emitAndAwait is only available when the tool is running in an event plane');
    },
    runControls: ToolRunControls = {},
  ) {
    this.#definitions = definitions;
    this.#layers = layers;
    this.#emit = emit;
    this.#emitAndAwait = emitAndAwait;
    this.#runControls = runControls;
  }

  toToolSchemas(): ReadonlyArray<TTools['schema']> {
    return this.#definitions.map((tool) => tool.schema);
  }

  /** JSON Schema of every tool, derived from its Effect input schema. */
  toJsonSchemas(): ReadonlyArray<ToolJsonSchema> {
    return this.#definitions.map((tool) => tool.toJsonSchema());
  }

  /** Tools for OpenAI Chat Completions `tools` (`{ type: 'function', function }`). */
  toOpenAI(): Array<OpenAIFunctionTool> {
    return toOpenAITools(this.#definitions);
  }

  /** Tools for the Anthropic Messages API `tools` (`{ name, description, input_schema }`). */
  toAnthropic(): Array<AnthropicTool> {
    return toAnthropicTools(this.#definitions);
  }

  /**
   * Bound tools as an AI SDK v5 `ToolSet`. Pass `{ jsonSchema }` from `ai`:
   * `generateText({ tools: tools.toAiSdk({ jsonSchema }) })`.
   */
  toAiSdk<TSchema>(helpers: AiSdkHelpers<TSchema>): Record<string, AiSdkTool<TSchema>> {
    return toAiSdkTools(this.toTools(), helpers);
  }

  toTools(): ReadonlyArray<BoundTool> {
    return this.#definitions.map((tool) => {
      const bindable = tool as unknown as BindableTool;
      return bindable.bind({
        layers: this.#layers as unknown as AnyLayers,
        emit: this.#emit as AnyToolEmitFn,
        emitAndAwait: this.#emitAndAwait as AnyToolEmitAndAwaitFn,
        signal: this.#runControls.signal,
        complete: this.#runControls.complete,
        tracing: this.#runControls.tracing,
        reportUsage: this.#runControls.reportUsage,
        principal: this.#runControls.principal,
        agentId: this.#runControls.agentId,
        onInvalidEmit: this.#runControls.onInvalidEmit,
      });
    });
  }
}

export class Tool<
  TInput = unknown,
  TOutput = unknown,
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
  TEmits extends EventDef = never,
> {
  private _name: string;
  private _description: string;
  private _inputSchema: S.Schema<TInput> | undefined;
  private _outputSchema: S.Schema<TOutput> | undefined;
  private _layers: ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>>;
  private _emits: ReadonlyArray<EventDef>;
  private _replyEvents: ReadonlyArray<string>;
  private _timeoutMs: number | undefined;
  private _retry: RetryPolicy | undefined;

  private constructor(params: ConstructorParams<TInput, TOutput, TDeps, TEmits>) {
    this._name = params.name;
    this._description = params.description;
    this._inputSchema = params.inputSchema;
    this._outputSchema = params.outputSchema;
    this._layers = params.layers as ReadonlyArray<
      DependencyLayerDef<string, unknown, S.Schema.Any>
    >;
    this._emits = params.emits;
    this._replyEvents = params.replyEvents ?? [];
    this._timeoutMs = params.timeoutMs;
    this._retry = params.retry;
  }

  private getState(): ConstructorParams<TInput, TOutput, TDeps, TEmits> {
    return {
      name: this._name,
      description: this._description,
      inputSchema: this._inputSchema,
      outputSchema: this._outputSchema,
      layers: this._layers as ReadonlyArray<TDeps>,
      emits: this._emits as ReadonlyArray<TEmits>,
      replyEvents: this._replyEvents,
      timeoutMs: this._timeoutMs,
      retry: this._retry,
    };
  }

  static of(options: { name: string; description: string }): Tool<unknown, unknown, never, never> {
    assertValidToolName(options.name);
    return new Tool<unknown, unknown, never, never>({
      name: options.name,
      description: options.description,
      layers: [],
      emits: [],
    });
  }

  input<ISchema extends S.Schema.Any>(
    schema: ISchema,
  ): Tool<S.Schema.Type<ISchema>, TOutput, TDeps, TEmits> {
    return new Tool({
      ...(this.getState() as unknown as ConstructorParams<
        S.Schema.Type<ISchema>,
        TOutput,
        TDeps,
        TEmits
      >),
      inputSchema: schema as unknown as S.Schema<S.Schema.Type<ISchema>>,
    });
  }

  output<OSchema extends S.Schema.Any>(
    schema: OSchema,
  ): Tool<TInput, S.Schema.Type<OSchema>, TDeps, TEmits> {
    return new Tool({
      ...(this.getState() as unknown as ConstructorParams<
        TInput,
        S.Schema.Type<OSchema>,
        TDeps,
        TEmits
      >),
      outputSchema: schema as unknown as S.Schema<S.Schema.Type<OSchema>>,
    });
  }

  dependsOn<D extends DependencyLayerDef<string, unknown, S.Schema.Any>>(
    ...layers: [D, ...D[]] | [ReadonlyArray<D>]
  ): Tool<TInput, TOutput, TDeps | D, TEmits> {
    const normalized = toLayerArray(layers);
    const allLayers = [...this._layers, ...normalized];
    assertUniqueLayerNames(allLayers);
    return new Tool({
      ...(this.getState() as unknown as ConstructorParams<TInput, TOutput, TDeps | D, TEmits>),
      layers: allLayers as unknown as ReadonlyArray<TDeps | D>,
    });
  }

  /**
   * Declares events the tool may emit. With `{ reply: true }` they only answer an
   * `emitAndAwait`, so the wiring check does not expect a listener for them.
   */
  emits<E extends EventDef>(
    events: Array<E>,
    options?: EmitsOptions,
  ): Tool<TInput, TOutput, TDeps, TEmits | E> {
    return new Tool({
      ...(this.getState() as unknown as ConstructorParams<TInput, TOutput, TDeps, TEmits | E>),
      emits: [...this._emits, ...events] as unknown as ReadonlyArray<TEmits | E>,
      replyEvents: options?.reply
        ? [...this._replyEvents, ...events.map((e) => e.name)]
        : this._replyEvents,
    });
  }

  /**
   * Fails a call with `ToolTimeoutError` when it runs longer than `duration` (per attempt with
   * `.retry()`). The tool's `signal` is aborted with that error so well-behaved tools stop;
   * the calling run's signal is left alone.
   */
  timeout(duration: Duration.DurationInput): Tool<TInput, TOutput, TDeps, TEmits> {
    const ms = toMillis(duration);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new ToolDefinitionError(
        this._name,
        `Tool "${this._name}": timeout must be a positive, finite duration; got ${String(duration)}.`,
      );
    }
    return new Tool({ ...this.getState(), timeoutMs: ms });
  }

  /**
   * Retries a call up to `times` more times when the tool throws (`ToolExecutionError`), with an
   * optional backoff. Invalid input, invalid output and timeouts are never retried, and no
   * attempt starts once the signal is aborted (an abort also cuts a backoff wait short).
   */
  retry(options: ToolRetryOptions): Tool<TInput, TOutput, TDeps, TEmits> {
    const fail = (detail: string): never => {
      throw new ToolDefinitionError(this._name, `Tool "${this._name}": ${detail}`);
    };
    const { times, backoff } = options;
    if (!Number.isInteger(times) || times < 0) {
      fail(`retry times must be a non-negative integer; got ${times}.`);
    }
    const baseMs = backoff ? toMillis(backoff.base) : 0;
    const factor = backoff?.factor ?? 2;
    const maxMs = backoff?.max === undefined ? Number.POSITIVE_INFINITY : toMillis(backoff.max);
    if (!Number.isFinite(baseMs) || baseMs < 0) {
      fail('retry backoff base must be a non-negative, finite duration.');
    }
    if (!Number.isFinite(factor) || factor < 1) fail('retry backoff factor must be >= 1.');
    if (Number.isNaN(maxMs) || maxMs < 0)
      fail('retry backoff max must be a non-negative duration.');
    return new Tool({ ...this.getState(), retry: { times, baseMs, factor, maxMs } });
  }

  define(
    fn: ToolExecuteFn<TInput, TOutput, LayersFromDeps<TDeps>, TEmits>,
  ): ToolDefinition<TInput, TOutput, TDeps, TEmits> {
    const state = this.getState();
    const inputSchema = state.inputSchema;
    const outputSchema = state.outputSchema;

    if (!inputSchema || !outputSchema) {
      throw new Error('Tool.define requires input() and output() to be called before define()');
    }

    const schema: ToolSchema<TInput, TOutput> = {
      name: state.name,
      description: state.description,
      input: inputSchema,
      output: outputSchema,
    };
    const jsonSchema = deriveToolJsonSchema(state.name, state.description, inputSchema);
    const dependencyLayers = state.layers;
    const emitEvents = state.emits;
    const decodeInput = S.decodeUnknownEither(inputSchema, { errors: 'all' });
    const decodeOutput = S.decodeUnknownEither(outputSchema, { errors: 'all' });
    const { timeoutMs } = state;
    const retry = state.retry ?? { times: 0, baseMs: 0, factor: 1, maxMs: 0 };

    return {
      schema,
      dependencyLayers,
      emitEvents,
      replyEvents: state.replyEvents ?? [],
      toJsonSchema: () => structuredClone(jsonSchema),
      bind(options: ToolBindOptions<LayersFromDeps<TDeps>, TEmits>): BoundTool<TInput, TOutput> {
        // Emits are checked against the tool's own declared events, wherever it is bound.
        const guard = {
          emits: emitEvents,
          source: { toolName: state.name, agentId: options.agentId },
          onInvalidEmit: options.onInvalidEmit,
        };
        const emit = guardEmit(
          options.emit ??
            ((_event: EmitPayload<TEmits>): void => {
              // no-op – tools can run outside an agent invoke
            }),
          guard,
        );
        const emitAndAwait = guardEmitAndAwait(
          options.emitAndAwait ??
            (async (): Promise<Envelope> => {
              throw new Error(
                'emitAndAwait is only available when the tool is running in an event plane',
              );
            }),
          guard,
        );
        const signal = options.signal ?? new AbortController().signal;
        const complete =
          options.complete ??
          ((): void => {
            // no-op – there is no run to end outside an agent invoke
          });
        const executeUntraced = async (
          input: unknown,
          callOptions?: ToolExecuteOptions,
        ): Promise<TOutput> => {
          const toolCallId = callOptions?.toolCallId ?? crypto.randomUUID();
          const linked = linkAbortSignals([signal, callOptions?.signal]);
          let output: TOutput;
          try {
            linked.signal.throwIfAborted();
            const decodedInput = decodeInput(input);
            if (Either.isLeft(decodedInput)) {
              throw new ToolInputError(state.name, toToolIssues(decodedInput.left));
            }
            const runOnce = (attemptSignal: AbortSignal) =>
              fn({
                input: decodedInput.right,
                layers: options.layers,
                emit,
                emitAndAwait,
                toolCallId,
                signal: attemptSignal,
                complete,
                reportUsage: (usage) =>
                  options.reportUsage?.(usage, { tool: { name: state.name, toolCallId } }),
                principal: options.principal,
              });
            for (let attempt = 1; ; attempt++) {
              try {
                output = await runAttempt(state.name, runOnce, linked.signal, timeoutMs, attempt);
                break;
              } catch (error) {
                // Only the tool throwing is worth another try; cancellation already rethrew.
                if (!(error instanceof ToolExecutionError) || attempt > retry.times) throw error;
                const delayMs = Math.min(retry.baseMs * retry.factor ** (attempt - 1), retry.maxMs);
                await abortableDelay(delayMs, linked.signal);
              }
            }
          } finally {
            linked.dispose();
          }
          const decodedOutput = decodeOutput(output);
          if (Either.isLeft(decodedOutput)) {
            throw new ToolOutputError(state.name, toToolIssues(decodedOutput.left));
          }
          return decodedOutput.right;
        };
        const execute = async (
          input: unknown,
          callOptions?: ToolExecuteOptions,
        ): Promise<TOutput> => {
          const span = startToolSpan(options.tracing, state.name, input);
          try {
            const output = await executeUntraced(input, callOptions);
            await endToolSpan(span, output);
            return output;
          } catch (error) {
            await endToolSpan(span, undefined, error);
            throw error;
          }
        };
        return {
          schema,
          toJsonSchema: () => structuredClone(jsonSchema),
          execute,
          executeForModel: async (input, callOptions) => {
            try {
              return { ok: true, output: await execute(input, callOptions) };
            } catch (error) {
              // A cancelled call stops the caller, whatever the abort reason looks like.
              const cancelled = signal.aborted || callOptions?.signal?.aborted === true;
              const modelError = cancelled ? undefined : toToolModelError(error);
              if (modelError === undefined) throw error;
              return { ok: false, error: modelError };
            }
          },
        };
      },
    };
  }
}
