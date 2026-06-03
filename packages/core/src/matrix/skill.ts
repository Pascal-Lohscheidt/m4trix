import { Effect, Schema as S } from 'effect';
import type { ParseError } from 'effect/ParseResult';
import {
  assertUniqueLayerNames,
  type DepedencyLayerDef,
  type LayersFromDeps,
  toLayerArray,
} from './dependency-layer.js';

export {
  DepedencyLayer,
  type DepedencyLayerDef,
  LayerName,
  type LayersFromDeps,
} from './dependency-layer.js';

/**
 * A skill is commonly used by now in the agentic ecosystem.
 * However I want to formalize this into the type world.
 * A skill should be the perfect interface.
 *
 * It can be converted into a tool to be used by an agent.
 * It should also be able to be used as a subsystem. E.g. a sub network.
 * Or even a single agent.
 *
 * In order to achieve that level of separation we should borrow a few concepts from effect.
 *
 * One of them is layers.
 *
 * A skill has dependencies. Things it needs to work.
 * We need to provide those.
 * A common example would be a database connection.
 * Or an auth user context.
 */

/** Unique brand symbol for Done, following Effect's branded-type pattern */
const DoneTypeId: unique symbol = Symbol.for('sunken-trove/Done');
type DoneTypeId = typeof DoneTypeId;

export interface Done<A> {
  readonly [DoneTypeId]: DoneTypeId;
  readonly _tag: 'Done';
  readonly done: A;
}

export const Done = {
  of<A>(value: A): Done<A> {
    return { [DoneTypeId]: DoneTypeId, _tag: 'Done' as const, done: value };
  },
  is(u: unknown): u is Done<unknown> {
    return (
      typeof u === 'object' &&
      u !== null &&
      DoneTypeId in u &&
      (u as Record<PropertyKey, unknown>)[DoneTypeId] === DoneTypeId
    );
  },
};

/** Minimal runtime options placeholder (logger, trace, etc. can be extended later) */
export type SkillRuntimeOptions = Record<string, unknown>;

/** Context passed to the define callback */
export type SkillDefineContext<TIn, TChunk, TLayers> = {
  input: TIn;
  emit: (chunk: TChunk) => void;
  layers: TLayers;
};

/** Define function signature */
type DefineFn<TIn, TChunk, TDone, TLayers> = (
  ctx: SkillDefineContext<TIn, TChunk, TLayers>,
) => TDone | Promise<TDone>;

/** Final executable skill instance */
export type SkillInstance<TInput, TChunk, TDone, TLayers> = {
  invokeStream: (
    input: TInput,
    runtime?: { layers: TLayers } & SkillRuntimeOptions,
  ) => AsyncIterable<TChunk | Done<TDone>>;
  /** Input is decoded to TInput before being passed to the skill logic */
  invoke: (
    input: TInput,
    runtime?: { layers: TLayers } & SkillRuntimeOptions,
  ) => Promise<{ chunks: TChunk[]; done: TDone }>;
} & { readonly _input?: TInput };

type ConstructorParams<
  TInput,
  TChunk,
  TDone,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
> = {
  inputSchema?: S.Schema<TInput>;
  chunkSchema?: S.Schema<TChunk>;
  doneSchema?: S.Schema<TDone>;
  layers: ReadonlyArray<TDeps>;
  defineFn?: DefineFn<TInput, TChunk, TDone, LayersFromDeps<TDeps>>;
};

export class Skill<
  TInput = unknown,
  TChunk = unknown,
  TDone = unknown,
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
> {
  private _inputSchema: S.Schema<TInput> | undefined;
  private _chunkSchema: S.Schema<TChunk> | undefined;
  private _doneSchema: S.Schema<TDone> | undefined;
  private _layers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
  private _defineFn: DefineFn<TInput, TChunk, TDone, LayersFromDeps<TDeps>> | undefined;

  private constructor(params: ConstructorParams<TInput, TChunk, TDone, TDeps>) {
    this._inputSchema = params.inputSchema;
    this._chunkSchema = params.chunkSchema;
    this._doneSchema = params.doneSchema;
    this._layers = params.layers as ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
    this._defineFn = params.defineFn;
  }

  private getState(): ConstructorParams<TInput, TChunk, TDone, TDeps> {
    return {
      inputSchema: this._inputSchema,
      chunkSchema: this._chunkSchema,
      doneSchema: this._doneSchema,
      layers: this._layers as ReadonlyArray<TDeps>,
      defineFn: this._defineFn,
    };
  }

  static of(_options?: SkillRuntimeOptions): Skill<unknown, unknown, unknown, never> {
    return new Skill<unknown, unknown, unknown, never>({
      layers: [],
    });
  }

  input<ISchema extends S.Schema.Any>(
    schema: ISchema,
  ): Skill<S.Schema.Type<ISchema>, TChunk, TDone, TDeps> {
    return new Skill({
      ...(this.getState() as unknown as ConstructorParams<
        S.Schema.Type<ISchema>,
        TChunk,
        TDone,
        TDeps
      >),
      inputSchema: schema as unknown as S.Schema<S.Schema.Type<ISchema>>,
    });
  }

  chunk<CSchema extends S.Schema.Any>(
    schema: CSchema,
  ): Skill<TInput, S.Schema.Type<CSchema>, TDone, TDeps> {
    return new Skill({
      ...(this.getState() as unknown as ConstructorParams<
        TInput,
        S.Schema.Type<CSchema>,
        TDone,
        TDeps
      >),
      chunkSchema: schema as unknown as S.Schema<S.Schema.Type<CSchema>>,
    });
  }

  done<DSchema extends S.Schema.Any>(
    schema: DSchema,
  ): Skill<TInput, TChunk, S.Schema.Type<DSchema>, TDeps> {
    return new Skill({
      ...(this.getState() as unknown as ConstructorParams<
        TInput,
        TChunk,
        S.Schema.Type<DSchema>,
        TDeps
      >),
      doneSchema: schema as unknown as S.Schema<S.Schema.Type<DSchema>>,
    });
  }

  dependsOn<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
    ...layers: [D, ...D[]] | [ReadonlyArray<D>]
  ): Skill<TInput, TChunk, TDone, TDeps | D> {
    const normalized = toLayerArray(layers);
    const allLayers = [...this._layers, ...normalized];
    assertUniqueLayerNames(allLayers);
    return new Skill({
      ...(this.getState() as unknown as ConstructorParams<TInput, TChunk, TDone, TDeps | D>),
      layers: allLayers as unknown as ReadonlyArray<TDeps | D>,
    }) as Skill<TInput, TChunk, TDone, TDeps | D>;
  }

  define(
    fn: DefineFn<TInput, TChunk, TDone, LayersFromDeps<TDeps>>,
  ): SkillInstance<TInput, TChunk, TDone, LayersFromDeps<TDeps>> {
    const state = this.getState();
    const inputSchema = state.inputSchema;
    const chunkSchema = state.chunkSchema;
    const doneSchema = state.doneSchema;
    const defineFn = fn;

    if (!inputSchema || !chunkSchema || !doneSchema || !defineFn) {
      throw new Error(
        'Skill.define requires input(), chunk(), and done() to be called before define()',
      );
    }

    const decodeInput = S.decodeUnknown(inputSchema);
    const decodeChunk = S.decodeUnknown(chunkSchema);
    const decodeDone = S.decodeUnknown(doneSchema);

    const runDefine = async (
      input: TInput,
      runtime?: { layers: LayersFromDeps<TDeps> } & SkillRuntimeOptions,
    ): Promise<{ chunks: TChunk[]; done: TDone }> => {
      const layersObj = runtime?.layers ?? ({} as LayersFromDeps<TDeps>);
      const chunks: TChunk[] = [];
      const emit = (chunk: TChunk): void => {
        const decoded = Effect.runSync(decodeChunk(chunk) as Effect.Effect<TChunk, ParseError>);
        chunks.push(decoded);
      };
      const done = await defineFn({
        input,
        emit,
        layers: layersObj,
      });
      const decodedDone = Effect.runSync(decodeDone(done) as Effect.Effect<TDone, ParseError>);
      return { chunks, done: decodedDone };
    };

    return {
      invokeStream: async function* (
        input: unknown,
        runtime?: { layers: LayersFromDeps<TDeps> } & SkillRuntimeOptions,
      ): AsyncGenerator<TChunk | Done<TDone>, void, undefined> {
        const decodedInput = Effect.runSync(
          decodeInput(input) as Effect.Effect<TInput, ParseError>,
        );
        const layersObj = runtime?.layers ?? ({} as LayersFromDeps<TDeps>);
        const chunks: TChunk[] = [];
        const emit = (chunk: TChunk): void => {
          const decoded = Effect.runSync(decodeChunk(chunk) as Effect.Effect<TChunk, ParseError>);
          chunks.push(decoded);
        };
        const done = await defineFn({
          input: decodedInput,
          emit,
          layers: layersObj,
        });
        const decodedDone = Effect.runSync(decodeDone(done) as Effect.Effect<TDone, ParseError>);
        for (const c of chunks) {
          yield c;
        }
        yield Done.of(decodedDone);
      },
      invoke: async (
        input: unknown,
        runtime?: { layers: LayersFromDeps<TDeps> } & SkillRuntimeOptions,
      ): Promise<{ chunks: TChunk[]; done: TDone }> => {
        const decodedInput = Effect.runSync(
          decodeInput(input) as Effect.Effect<TInput, ParseError>,
        );
        return runDefine(decodedInput, runtime);
      },
    };
  }
}
