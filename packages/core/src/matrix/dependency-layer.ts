import { Brand, Effect, Schema as S } from 'effect';
import type { ParseError } from 'effect/ParseResult';

/** Regex: PascalCase (e.g. MyLayerFoo) */
const PASCAL_CASE_REGEX = /^[A-Z][a-zA-Z0-9]*$/;

export const DepedencyLayerInstanceTypeId: unique symbol = Symbol.for(
  'sunken-trove/DependencyLayerInstance',
);

/**
 * Branded type for layer/dependency names. Enforces PascalCase at runtime via refinement.
 * Used internally for parsing, validation, and uniqueness enforcement across layers.
 */
export type LayerName = string & Brand.Brand<'LayerName'>;

export const LayerName = Brand.refined<LayerName>(
  (s: unknown) => typeof s === 'string' && PASCAL_CASE_REGEX.test(s),
  (s: unknown) => Brand.error(`Expected PascalCase (e.g. MyLayerFoo), got: ${s}`),
);

/** Error type when DepType contains reserved 'config' - produces explicit type error */
type ReservedConfigError = "DepType must not contain 'config' - it is reserved by the layer";

export type DepedencyLayerValue<DepType, ConfigSchema extends S.Schema.Any> = Omit<
  DepType,
  'config'
> & {
  config: S.Schema.Type<ConfigSchema>;
};

export type DepedencyLayerInstance<
  N extends string,
  DepType,
  ConfigSchema extends S.Schema.Any,
> = DepedencyLayerValue<DepType, ConfigSchema> & {
  readonly [DepedencyLayerInstanceTypeId]: {
    readonly name: N;
  };
};

type DepedencyLayerMakeInput<DepType> = Omit<DepType, 'config'> & { config: unknown };

/** Definition of a single dependency layer with a branded name and config schema */
export type DepedencyLayerDef<N extends string, DepType, ConfigSchema extends S.Schema.Any> = {
  readonly _tag: 'SkillDependencyDef';
  readonly name: LayerName;
  readonly _name: N;
  readonly config: ConfigSchema;
  readonly decodeConfig: (u: unknown) => Effect.Effect<S.Schema.Type<ConfigSchema>, ParseError>;
  make(value: DepedencyLayerMakeInput<DepType>): DepedencyLayerInstance<N, DepType, ConfigSchema>;
};

/** Build layers object type from a tuple of dependency definitions */
type DependenciesToLayers<T> =
  T extends DepedencyLayerDef<infer N, infer DepType, infer ConfigSchema>
    ? { [K in N]: DepedencyLayerValue<DepType, ConfigSchema> }
    : never;

type DependenciesToLayerInstances<T> =
  T extends DepedencyLayerDef<infer N, infer DepType, infer ConfigSchema>
    ? { [K in N]: DepedencyLayerInstance<N, DepType, ConfigSchema> }
    : never;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/** Build layers object from union of dependency types */
export type LayersFromDeps<T extends DepedencyLayerDef<string, unknown, S.Schema.Any>> = [
  T,
] extends [never]
  ? Record<string, never>
  : UnionToIntersection<DependenciesToLayers<T>>;

/** Build runtime layer instance object from union of dependency types */
export type LayerInstancesFromDeps<T extends DepedencyLayerDef<string, unknown, S.Schema.Any>> = [
  T,
] extends [never]
  ? Record<string, never>
  : UnionToIntersection<DependenciesToLayerInstances<T>>;

type DepedencyLayerBuilder<N extends string, ConfigSchema extends S.Schema.Any> = DepedencyLayerDef<
  N,
  object,
  ConfigSchema
> & {
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
    const typedDecodeConfig = decodeConfig as (
      u: unknown,
    ) => Effect.Effect<S.Schema.Type<ConfigSchema>, ParseError>;
    const dep = {
      _tag: 'SkillDependencyDef' as const,
      name,
      _name: def.name,
      config: def.config,
      decodeConfig: typedDecodeConfig,
      make(value: DepedencyLayerMakeInput<unknown>) {
        const decodedConfig = Effect.runSync(typedDecodeConfig(value.config));
        const instance = {
          ...value,
          config: decodedConfig,
        } as DepedencyLayerInstance<N, unknown, ConfigSchema>;

        Object.defineProperty(instance, DepedencyLayerInstanceTypeId, {
          value: { name: def.name },
          enumerable: false,
        });

        return instance;
      },
    };
    return Object.assign(dep, {
      define: () => dep,
    }) as unknown as DepedencyLayerBuilder<N, ConfigSchema>;
  },
};

/** Normalize single or array of layers to readonly array */
export function toLayerArray<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
  layers: [D, ...D[]] | [ReadonlyArray<D>],
): ReadonlyArray<D> {
  if (layers.length === 1 && Array.isArray(layers[0])) {
    return layers[0];
  }
  return [...(layers as [D, ...D[]])];
}

/** Check for duplicate layer names and throw if found */
export function assertUniqueLayerNames<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
  layers: ReadonlyArray<D>,
): void {
  const seen = new Set<string>();
  for (const dep of layers) {
    const key = dep.name as string;
    if (seen.has(key)) {
      throw new Error(`Duplicate layer name: ${key}`);
    }
    seen.add(key);
  }
}

/** Merge layer lists, keeping the first definition when names repeat (e.g. shared tool deps). */
export function mergeDependencyLayers<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
  layers: ReadonlyArray<D>,
): ReadonlyArray<D> {
  const seen = new Set<string>();
  const merged: D[] = [];
  for (const dep of layers) {
    const key = dep._name;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(dep);
    }
  }
  return merged;
}

export function isDepedencyLayerInstance(
  u: unknown,
): u is DepedencyLayerInstance<string, unknown, S.Schema.Any> {
  return typeof u === 'object' && u !== null && DepedencyLayerInstanceTypeId in u;
}

/** Ensure an agent's declared dependencies are covered by the network contract */
export function assertDepedencyMatch(options: {
  agentId: string;
  agentLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
  networkLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
}): void {
  const networkNames = new Set(options.networkLayers.map((layer) => layer._name));
  const missing = options.agentLayers
    .map((layer) => layer._name)
    .filter((name) => !networkNames.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Dependency mismatch for agent ${options.agentId}: missing network layer(s): ${missing.join(', ')}`,
    );
  }
}

/** Ensure runtime injection includes all network-declared dependency layers */
export function assertLayersProvided(
  networkLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>,
  injected: Record<string, unknown> | undefined,
): void {
  if (networkLayers.length === 0) {
    return;
  }

  if (!injected) {
    throw new Error('Network run requires layers injection for declared dependencies');
  }

  const missing = networkLayers.map((layer) => layer._name).filter((name) => !(name in injected));

  if (missing.length > 0) {
    throw new Error(`Missing injected layer(s): ${missing.join(', ')}`);
  }

  const invalid = networkLayers
    .map((layer) => layer._name)
    .filter((name) => {
      const value = injected[name];
      if (!isDepedencyLayerInstance(value)) {
        return true;
      }
      return value[DepedencyLayerInstanceTypeId].name !== name;
    });

  if (invalid.length > 0) {
    throw new Error(`Invalid injected layer instance(s): ${invalid.join(', ')}`);
  }
}
