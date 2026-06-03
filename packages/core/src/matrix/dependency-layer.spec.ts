import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  assertDepedencyMatch,
  assertLayersProvided,
  DepedencyLayer,
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

describe('DepedencyLayer', () => {
  test('creates a dependency with name and config', () => {
    const dep = DepedencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    });

    expect(dep._tag).toBe('SkillDependencyDef');
    expect(dep._name).toBe('MyLayerFoo');
    expect(dep.config).toBeDefined();
  });

  test('decodeConfig validates and returns typed value', () => {
    const dep = DepedencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    });

    const result = Effect.runSync(dep.decodeConfig({ foo: 'bar' }));
    expect(result).toEqual({ foo: 'bar' });
  });

  test('decodeConfig throws on invalid input', () => {
    const dep = DepedencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    });

    expect(() => Effect.runSync(dep.decodeConfig({ foo: 123 }))).toThrow();
    expect(() => Effect.runSync(dep.decodeConfig({ wrongKey: 'x' }))).toThrow();
  });

  test('DepType with config property causes type error', () => {
    DepedencyLayer.of({
      name: 'Ok',
      config: S.Struct({ x: S.Number }),
    });

    const badDep = DepedencyLayer.of({
      name: 'Ok',
      config: S.Struct({ x: S.Number }),
    }).define<{ config: string }>();
    expectTypeOf(
      badDep,
    ).toEqualTypeOf<"DepType must not contain 'config' - it is reserved by the layer">();
  });

  test('make creates a typed layer instance and decodes config', () => {
    const OpenAi = DepedencyLayer.of({
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

  test('make rejects invalid config', () => {
    const OpenAi = DepedencyLayer.of({
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

describe('assertDepedencyMatch', () => {
  const openAiLayer = DepedencyLayer.of({
    name: 'OpenAi',
    config: S.Struct({ model: S.String }),
  });

  const dbLayer = DepedencyLayer.of({
    name: 'Db',
    config: S.Struct({}),
  });

  test('passes when agent dependencies are declared by the network', () => {
    expect(() =>
      assertDepedencyMatch({
        agentId: 'agent-1',
        agentLayers: [openAiLayer],
        networkLayers: [openAiLayer, dbLayer],
      }),
    ).not.toThrow();
  });

  test('throws when agent requires layers missing from the network', () => {
    expect(() =>
      assertDepedencyMatch({
        agentId: 'agent-1',
        agentLayers: [openAiLayer],
        networkLayers: [dbLayer],
      }),
    ).toThrow('Dependency mismatch for agent agent-1: missing network layer(s): OpenAi');
  });
});

describe('assertLayersProvided', () => {
  const openAiLayer = DepedencyLayer.of({
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
