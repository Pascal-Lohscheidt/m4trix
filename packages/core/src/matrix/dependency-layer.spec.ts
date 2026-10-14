import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  assertDependencyMatch,
  assertLayersProvided,
  DependencyLayer,
  type DependencyLayerDef,
  DependencyLayerInstanceTypeId,
  isDependencyLayerInstance,
  LayerName,
} from './dependency-layer.js';

describe('LayerName', () => {
  test('accepts valid PascalCase strings', () => {
    expect(LayerName('MyLayerFoo')).toBe('MyLayerFoo');
    expect(LayerName('A')).toBe('A');
    expect(LayerName('FooBar')).toBe('FooBar');
  });

  test('rejects invalid formats', () => {
    expect(() => LayerName('kebab-case')).toThrow();
    expect(() => LayerName('camelCase')).toThrow();
    expect(() => LayerName('')).toThrow();
    expect(() => LayerName('123')).toThrow();
  });
});

describe('DependencyLayer', () => {
  test('creates a dependency with name and config', () => {
    const dep = DependencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    });

    expect(dep._tag).toBe('DependencyLayerDef');
    expect(dep._name).toBe('MyLayerFoo');
    expect(dep.config).toBeDefined();
  });

  test('decodeConfig validates and returns typed value', () => {
    const dep = DependencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    });

    const result = Effect.runSync(dep.decodeConfig({ foo: 'bar' }));
    expect(result).toEqual({ foo: 'bar' });
  });

  test('decodeConfig throws on invalid input', () => {
    const dep = DependencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    });

    expect(() => Effect.runSync(dep.decodeConfig({ foo: 123 }))).toThrow();
    expect(() => Effect.runSync(dep.decodeConfig({ wrongKey: 'x' }))).toThrow();
  });

  test('DepType with config property causes type error', () => {
    DependencyLayer.of({
      name: 'Ok',
      config: S.Struct({ x: S.Number }),
    });

    const badDep = DependencyLayer.of({
      name: 'Ok',
      config: S.Struct({ x: S.Number }),
    }).define<{ config: string }>();
    expectTypeOf(
      badDep,
    ).toEqualTypeOf<"DepType must not contain 'config' - it is reserved by the layer">();
  });

  test('make creates a typed layer instance and decodes config', () => {
    const OpenAi = DependencyLayer.of({
      name: 'OpenAi',
      config: S.Struct({ model: S.String }),
    }).define<{ client: { complete: (prompt: string) => Promise<string> } }>();

    const instance = OpenAi.make({
      config: { model: 'gpt-4o' },
      client: { complete: async (prompt) => prompt },
    });

    expect(instance.config).toEqual({ model: 'gpt-4o' });
    expectTypeOf(instance.client.complete).parameters.toEqualTypeOf<[string]>();
  });

  test('layer instances are branded under the m4trix symbol namespace', () => {
    const dep = DependencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    }).define<{ ping: () => string }>();
    const instance = dep.make({ config: { foo: 'x' }, ping: () => 'pong' });

    expect(DependencyLayerInstanceTypeId).toBe(Symbol.for('m4trix/DependencyLayerInstance'));
    expect(isDependencyLayerInstance(instance)).toBe(true);
    expect(instance[DependencyLayerInstanceTypeId]).toEqual({ name: 'MyLayerFoo' });
    expect(isDependencyLayerInstance({ config: { foo: 'x' } })).toBe(false);
    expectTypeOf(dep).toMatchTypeOf<
      DependencyLayerDef<'MyLayerFoo', { ping: () => string }, S.Struct<{ foo: typeof S.String }>>
    >();
  });

  test('make rejects invalid config', () => {
    const OpenAi = DependencyLayer.of({
      name: 'OpenAi',
      config: S.Struct({ model: S.String }),
    }).define<{ client: object }>();

    expect(() =>
      OpenAi.make({
        config: { model: 123 },
        client: {},
      }),
    ).toThrow();
  });
});

describe('assertDependencyMatch', () => {
  const openAiLayer = DependencyLayer.of({
    name: 'OpenAi',
    config: S.Struct({ model: S.String }),
  });

  const dbLayer = DependencyLayer.of({
    name: 'Db',
    config: S.Struct({}),
  });

  test('passes when agent dependencies are declared by the network', () => {
    expect(() =>
      assertDependencyMatch({
        agentId: 'agent-1',
        agentLayers: [openAiLayer],
        networkLayers: [openAiLayer, dbLayer],
      }),
    ).not.toThrow();
  });

  test('throws when agent requires layers missing from the network', () => {
    expect(() =>
      assertDependencyMatch({
        agentId: 'agent-1',
        agentLayers: [openAiLayer],
        networkLayers: [dbLayer],
      }),
    ).toThrow('Dependency mismatch for agent agent-1: missing network layer(s): OpenAi');
  });
});

describe('assertLayersProvided', () => {
  const openAiLayer = DependencyLayer.of({
    name: 'OpenAi',
    config: S.Struct({ model: S.String }),
  }).define<{ client: object }>();

  test('passes when no network dependencies are declared', () => {
    expect(() => assertLayersProvided([], undefined)).not.toThrow();
  });

  test('throws when layers are required but not injected', () => {
    expect(() => assertLayersProvided([openAiLayer], undefined)).toThrow(
      'Network run requires layers injection for declared dependencies',
    );
  });

  test('throws when injected layers are incomplete', () => {
    expect(() => assertLayersProvided([openAiLayer], {})).toThrow(
      'Missing injected layer(s): OpenAi',
    );
  });

  test('throws when injected layer is not an instance', () => {
    expect(() =>
      assertLayersProvided([openAiLayer], {
        OpenAi: { client: {}, config: { model: 'gpt-4o' } },
      }),
    ).toThrow('Invalid injected layer instance(s): OpenAi');
  });

  test('passes when all declared layer instances are injected', () => {
    expect(() =>
      assertLayersProvided([openAiLayer], {
        OpenAi: openAiLayer.make({ client: {}, config: { model: 'gpt-4o' } }),
      }),
    ).not.toThrow();
  });
});
