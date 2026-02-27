import { Brand, Effect, Schema as S } from 'effect';
import type { ParseError } from 'effect/ParseResult';

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

/** Regex: camelCase (e.g. myLayerFoo) */
const CAMEL_CASE_REGEX = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Branded type for layer/dependency names. Enforces camelCase at runtime via refinement.
 * Used internally for parsing, validation, and uniqueness enforcement across layers.
 */
export type LayerName = string & Brand.Brand<'LayerName'>;

export const LayerName = Brand.refined<LayerName>(
  (s: unknown) => typeof s === 'string' && CAMEL_CASE_REGEX.test(s),
  (s: unknown) =>
    Brand.error(`Expected camelCase (e.g. myLayerFoo), got: ${s}`),
);

/** Error type when DepType contains reserved 'config' - produces explicit type error */
type ReservedConfigError =
  "DepType must not contain 'config' - it is reserved by the layer";

/** Definition of a single skill dependency with a branded name and config schema */
export type DepedencyLayerDef<
  N extends string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _DepType,
  ConfigSchema extends S.Schema.Any,
> = {
  readonly _tag: 'SkillDependencyDef';
  readonly name: LayerName;
  readonly _name: N;
  readonly config: ConfigSchema;
  readonly decodeConfig: (
    u: unknown,
  ) => Effect.Effect<S.Schema.Type<ConfigSchema>, ParseError>;
};

/** Layer value: DepType spread plus config (config is decoded from schema) */
type LayerValue<DepType, ConfigSchema extends S.Schema.Any> = Omit<
  DepType,
  'config'
> & { config: S.Schema.Type<ConfigSchema> };

/** Build layers object type from a tuple of dependency definitions */
type DependenciesToLayers<T> =
  T extends DepedencyLayerDef<infer N, infer DepType, infer ConfigSchema>
    ? { [K in N]: LayerValue<DepType, ConfigSchema> }
    : never;

type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/** Build layers object from union of dependency types */
export type LayersFromDeps<
  T extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
> = [T] extends [never]
  ? Record<string, never>
  : UnionToIntersection<DependenciesToLayers<T>>;

type DepedencyLayerBuilder<
  N extends string,
  ConfigSchema extends S.Schema.Any,
> = DepedencyLayerDef<N, object, ConfigSchema> & {
  define<_DepType>(): 'config' extends keyof _DepType
    ? ReservedConfigError
    : DepedencyLayerDef<N, _DepType, ConfigSchema>;
};

export const DepedencyLayer = {
  of<const N extends string, ConfigSchema extends S.Schema.Any>(def: {
    name: N;
    config: ConfigSchema;
  }): DepedencyLayerBuilder<N, ConfigSchema> {
    const name = LayerName(def.name as string);
    const decodeConfig = S.decodeUnknown(def.config);
    const dep = {
      _tag: 'SkillDependencyDef' as const,
      name,
      _name: def.name,
      config: def.config,
      decodeConfig: decodeConfig as (
        u: unknown,
      ) => Effect.Effect<S.Schema.Type<ConfigSchema>, ParseError>,
    };
    return Object.assign(dep, {
      define: () => dep,
    }) as unknown as DepedencyLayerBuilder<N, ConfigSchema>;
  },
};

/** Normalize single or array of layers to readonly array */
function toLayerArray<
  D extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
>(layers: [D, ...D[]] | [ReadonlyArray<D>]): ReadonlyArray<D> {
  if (layers.length === 1 && Array.isArray(layers[0])) {
    return layers[0];
  }
  return [...(layers as [D, ...D[]])];
}

/** Check for duplicate layer names and throw if found */
function assertUniqueLayerNames<
  D extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
>(layers: ReadonlyArray<D>): void {
  const seen = new Set<string>();
  for (const dep of layers) {
    const key = dep.name as string;
    if (seen.has(key)) {
      throw new Error(`Duplicate layer name: ${key}`);
    }
    seen.add(key);
  }
}

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
  private _layers: ReadonlyArray<
    DepedencyLayerDef<string, unknown, S.Schema.Any>
  >;
  private _defineFn:
    | DefineFn<TInput, TChunk, TDone, LayersFromDeps<TDeps>>
    | undefined;

  private constructor(params: ConstructorParams<TInput, TChunk, TDone, TDeps>) {
    this._inputSchema = params.inputSchema;
    this._chunkSchema = params.chunkSchema;
    this._doneSchema = params.doneSchema;
    this._layers = params.layers as ReadonlyArray<
      DepedencyLayerDef<string, unknown, S.Schema.Any>
    >;
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

  static of(
    _options?: SkillRuntimeOptions,
  ): Skill<unknown, unknown, unknown, never> {
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
      ...(this.getState() as unknown as ConstructorParams<
        TInput,
        TChunk,
        TDone,
        TDeps | D
      >),
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
        const decoded = Effect.runSync(
          decodeChunk(chunk) as Effect.Effect<TChunk, ParseError>,
        );
        chunks.push(decoded);
      };
      const done = await defineFn({
        input,
        emit,
        layers: layersObj,
      });
      const decodedDone = Effect.runSync(
        decodeDone(done) as Effect.Effect<TDone, ParseError>,
      );
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
          const decoded = Effect.runSync(
            decodeChunk(chunk) as Effect.Effect<TChunk, ParseError>,
          );
          chunks.push(decoded);
        };
        const done = await defineFn({
          input: decodedInput,
          emit,
          layers: layersObj,
        });
        const decodedDone = Effect.runSync(
          decodeDone(done) as Effect.Effect<TDone, ParseError>,
        );
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
