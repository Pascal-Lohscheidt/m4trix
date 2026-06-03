import { randomUUID } from 'node:crypto';
import { Effect, Schema as S } from 'effect';
import type * as Duration from 'effect/Duration';
import type { ParseError } from 'effect/ParseResult';
import type { EmitPayload } from './agent-factory.js';
import type { AgentNetworkEventDef } from './agent-network/agent-network-event.js';
import type { Envelope } from './agent-network/event-plane.js';
import {
  assertUniqueLayerNames,
  type DepedencyLayerDef,
  type LayersFromDeps,
  toLayerArray,
} from './dependency-layer.js';

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
  readonly emit: ToolEmitFn<EmitPayload<TEmits>>;
  readonly emitAndAwait: ToolEmitAndAwaitFn<EmitPayload<TEmits>>;
  readonly toolCallId: string;
};

type ToolExecuteFn<TInput, TOutput, TLayers, TEmits extends EventDef> = (
  ctx: ToolExecutionContext<TInput, TLayers, TEmits>,
) => TOutput | Promise<TOutput>;

type ConstructorParams<
  TInput,
  TOutput,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
  TEmits extends EventDef,
> = {
  name: string;
  description: string;
  inputSchema?: S.Schema<TInput>;
  outputSchema?: S.Schema<TOutput>;
  layers: ReadonlyArray<TDeps>;
  emits: ReadonlyArray<TEmits>;
};

type AnyLayers = LayersFromDeps<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
type AnyToolEmitFn = ToolEmitFn<unknown>;
type AnyToolEmitAndAwaitFn = ToolEmitAndAwaitFn<unknown>;

type BindableTool = {
  bind(options: ToolBindOptions<AnyLayers, EventDef>): BoundTool;
};

export type BoundTool<TInput = unknown, TOutput = unknown> = {
  readonly schema: ToolSchema<TInput, TOutput>;
  execute(input: unknown): Promise<TOutput>;
};

export type ToolBindOptions<TLayers, TEmits extends EventDef = never> = {
  readonly layers: TLayers;
  readonly emit?: ToolEmitFn<EmitPayload<TEmits>>;
  readonly emitAndAwait?: ToolEmitAndAwaitFn<EmitPayload<TEmits>>;
};

export type ToolDefinition<
  TInput = unknown,
  TOutput = unknown,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
  TEmits extends EventDef = never,
> = {
  readonly schema: ToolSchema<TInput, TOutput>;
  readonly dependencyLayers: ReadonlyArray<TDeps>;
  readonly emitEvents: ReadonlyArray<TEmits>;
  bind(options: ToolBindOptions<LayersFromDeps<TDeps>, TEmits>): BoundTool<TInput, TOutput>;
};

export type AnyToolDefinition = ToolDefinition<
  S.Schema.Type<S.Schema.Any>,
  S.Schema.Type<S.Schema.Any>,
  DepedencyLayerDef<string, unknown, S.Schema.Any>,
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
  TAgentDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
  TAgentEmit = never,
> {
  readonly #definitions: ReadonlyArray<TTools>;
  readonly #layers: LayersFromDeps<TAgentDeps>;
  readonly #emit: ToolEmitFn<TAgentEmit>;
  readonly #emitAndAwait: ToolEmitAndAwaitFn<TAgentEmit>;

  constructor(
    definitions: ReadonlyArray<TTools>,
    layers: LayersFromDeps<TAgentDeps>,
    emit: ToolEmitFn<TAgentEmit>,
    emitAndAwait: ToolEmitAndAwaitFn<TAgentEmit> = async () => {
      throw new Error('emitAndAwait is only available when the tool is running in an event plane');
    },
  ) {
    this.#definitions = definitions;
    this.#layers = layers;
    this.#emit = emit;
    this.#emitAndAwait = emitAndAwait;
  }

  toToolSchemas(): ReadonlyArray<TTools['schema']> {
    return this.#definitions.map((tool) => tool.schema);
  }

  toTools(): ReadonlyArray<BoundTool> {
    return this.#definitions.map((tool) => {
      const bindable = tool as unknown as BindableTool;
      return bindable.bind({
        layers: this.#layers as unknown as AnyLayers,
        emit: this.#emit as AnyToolEmitFn,
        emitAndAwait: this.#emitAndAwait as AnyToolEmitAndAwaitFn,
      });
    });
  }
}

export class Tool<
  TInput = unknown,
  TOutput = unknown,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
  TEmits extends EventDef = never,
> {
  private _name: string;
  private _description: string;
  private _inputSchema: S.Schema<TInput> | undefined;
  private _outputSchema: S.Schema<TOutput> | undefined;
  private _layers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
  private _emits: ReadonlyArray<EventDef>;

  private constructor(params: ConstructorParams<TInput, TOutput, TDeps, TEmits>) {
    this._name = params.name;
    this._description = params.description;
    this._inputSchema = params.inputSchema;
    this._outputSchema = params.outputSchema;
    this._layers = params.layers as ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
    this._emits = params.emits;
  }

  private getState(): ConstructorParams<TInput, TOutput, TDeps, TEmits> {
    return {
      name: this._name,
      description: this._description,
      inputSchema: this._inputSchema,
      outputSchema: this._outputSchema,
      layers: this._layers as ReadonlyArray<TDeps>,
      emits: this._emits as ReadonlyArray<TEmits>,
    };
  }

  static of(options: { name: string; description: string }): Tool<unknown, unknown, never, never> {
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

  dependsOn<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
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

  emits<E extends EventDef>(events: Array<E>): Tool<TInput, TOutput, TDeps, TEmits | E> {
    return new Tool({
      ...(this.getState() as unknown as ConstructorParams<TInput, TOutput, TDeps, TEmits | E>),
      emits: [...this._emits, ...events] as unknown as ReadonlyArray<TEmits | E>,
    });
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
    const dependencyLayers = state.layers;
    const emitEvents = state.emits;
    const decodeInput = S.decodeUnknown(inputSchema);
    const decodeOutput = S.decodeUnknown(outputSchema);

    return {
      schema,
      dependencyLayers,
      emitEvents,
      bind(options: ToolBindOptions<LayersFromDeps<TDeps>, TEmits>): BoundTool<TInput, TOutput> {
        const emit =
          options.emit ??
          ((_event: EmitPayload<TEmits>): void => {
            // no-op – tools can run outside an agent invoke
          });
        const emitAndAwait =
          options.emitAndAwait ??
          (async (): Promise<Envelope> => {
            throw new Error(
              'emitAndAwait is only available when the tool is running in an event plane',
            );
          });
        return {
          schema,
          execute: async (input: unknown): Promise<TOutput> => {
            const toolCallId = randomUUID();
            const decodedInput = Effect.runSync(
              decodeInput(input) as Effect.Effect<TInput, ParseError>,
            );
            const output = await fn({
              input: decodedInput,
              layers: options.layers,
              emit,
              emitAndAwait,
              toolCallId,
            });
            return Effect.runSync(decodeOutput(output) as Effect.Effect<TOutput, ParseError>);
          },
        };
      },
    };
  }
}
