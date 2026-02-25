import { describe, expect, test } from 'vitest';
import { Effect, Schema as S } from 'effect';
import { LayerName, Skill, DepedencyLayer, type SkillInstance } from './skill';

describe('LayerName', () => {
  test('accepts valid camelCase strings', () => {
    expect(LayerName('myLayerFoo')).toBe('myLayerFoo');
    expect(LayerName('a')).toBe('a');
    expect(LayerName('fooBar')).toBe('fooBar');
  });

  test('rejects invalid formats', () => {
    expect(() => LayerName('kebab-case')).toThrow();
    expect(() => LayerName('PascalCase')).toThrow();
    expect(() => LayerName('')).toThrow();
    expect(() => LayerName('123')).toThrow();
  });
});

describe('SkillDependency', () => {
  test('creates a dependency with name and shape', () => {
    const dep = DepedencyLayer.of({
      name: 'myLayerFoo',
      shape: S.Struct({ foo: S.String }),
    });

    expect(dep._tag).toBe('SkillDependencyDef');
    expect(dep._name).toBe('myLayerFoo');
    expect(dep.shape).toBeDefined();
  });

  test('decode validates and returns typed value', () => {
    const dep = DepedencyLayer.of({
      name: 'myLayerFoo',
      shape: S.Struct({ foo: S.String }),
    });

    const result = Effect.runSync(dep.decode({ foo: 'bar' }));
    expect(result).toEqual({ foo: 'bar' });
  });

  test('decode throws on invalid input', () => {
    const dep = DepedencyLayer.of({
      name: 'myLayerFoo',
      shape: S.Struct({ foo: S.String }),
    });

    expect(() => Effect.runSync(dep.decode({ foo: 123 }))).toThrow();
    expect(() => Effect.runSync(dep.decode({ wrongKey: 'x' }))).toThrow();
  });
});

describe('Skill', () => {
  test('creates skill with basic setup', () => {
    const skill = Skill.of()
      .input(S.Struct({ query: S.String }))
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(({ input, emit }) => {
        emit('chunk1');
        return { result: input.query };
      });

    expect(skill).toBeDefined();
    expect(skill.invoke).toBeDefined();
    expect(skill.invokeStream).toBeDefined();
  });

  test('invoke returns chunks and done', async () => {
    const skill = Skill.of()
      .input(S.Struct({ query: S.String }))
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(({ input, emit }) => {
        emit('a');
        emit('b');
        return { result: input.query };
      });

    const { chunks, done } = await skill.invoke({ query: 'test' });

    expect(chunks).toEqual(['a', 'b']);
    expect(done).toEqual({ result: 'test' });
  });

  test('invokeStream yields chunks then Done', async () => {
    const skill = Skill.of()
      .input(S.Struct({ x: S.Number }))
      .chunk(S.Number)
      .done(S.Struct({ sum: S.Number }))
      .define(({ input, emit }) => {
        emit(1);
        emit(2);
        return { sum: input.x + 3 };
      });

    const results: unknown[] = [];
    for await (const item of skill.invokeStream({ x: 10 })) {
      results.push(item);
    }

    expect(results).toEqual([1, 2, { _tag: 'Done', done: { sum: 13 } }]);
  });

  test('use accepts single layer', async () => {
    const myLayer = DepedencyLayer.of({
      name: 'myLayerFoo',
      shape: S.Struct({ foo: S.String }),
    });

    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.String)
      .done(S.Struct({ r: S.String }))
      .dependsOn(myLayer)
      .define(({ input, layers }) => {
        expect(layers.myLayerFoo).toEqual({ foo: 'bar' });
        return { r: input.q + layers.myLayerFoo.foo };
      });

    const { done } = await skill.invoke(
      { q: 'prefix-' },
      { layers: { myLayerFoo: { foo: 'bar' } } },
    );
    expect(done).toEqual({ r: 'prefix-bar' });
  });

  test('use accepts array of layers (same type)', async () => {
    const layer = DepedencyLayer.of({
      name: 'layerA',
      shape: S.Struct({ a: S.Number }),
    });

    const skill = Skill.of()
      .input(S.Struct({ x: S.Number }))
      .chunk(S.String)
      .done(S.Struct({ out: S.String }))
      .dependsOn([layer])
      .define(({ layers }) => {
        return { out: `${layers.layerA.a}` };
      });

    const { done } = await skill.invoke(
      { x: 1 },
      { layers: { layerA: { a: 42 } } },
    );
    expect(done).toEqual({ out: '42' });
  });

  test('use accepts multiple layers via chaining', async () => {
    const layerA = DepedencyLayer.of({
      name: 'layerA',
      shape: S.Struct({ a: S.Number }),
    });
    const layerB = DepedencyLayer.of({
      name: 'layerB',
      shape: S.Struct({ b: S.String }),
    });

    const skill = Skill.of()
      .input(S.Struct({ x: S.Number }))
      .chunk(S.String)
      .done(S.Struct({ out: S.String }))
      .dependsOn(layerA)
      .dependsOn(layerB)
      .define(({ layers }) => {
        return { out: `${layers.layerA.a}-${layers.layerB.b}` };
      });

    const { done } = await skill.invoke(
      { x: 1 },
      { layers: { layerA: { a: 99 }, layerB: { b: 'world' } } },
    );
    expect(done).toEqual({ out: '99-world' });
  });

  test('throws on duplicate layer names', () => {
    const layer = DepedencyLayer.of({
      name: 'dup',
      shape: S.Struct({ x: S.Number }),
    });

    expect(() =>
      Skill.of()
        .input(S.Struct({ q: S.String }))
        .chunk(S.String)
        .done(S.Struct({ r: S.String }))
        .dependsOn(layer)
        .dependsOn(layer)
        .define(() => ({ r: 'x' })),
    ).toThrow(/Duplicate layer name: dup/);
  });

  test('define throws when input/chunk/done not called', () => {
    expect(() => Skill.of().define(() => ({ r: 'x' }))).toThrow(
      /Skill.define requires input\(\)/,
    );
  });

  test('invoke decodes input and validates', async () => {
    const skill = Skill.of()
      .input(S.Struct({ query: S.String }))
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(({ input }) => ({ result: input.query }));

    // @ts-expect-error - wrongKey is not in the input schema
    await expect(skill.invoke({ wrongKey: 123 })).rejects.toThrow();
  });
});

describe('Skill type tests', () => {
  test('define callback receives typed input', () => {
    const skill = Skill.of()
      .input(S.Struct({ query: S.String }))
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(({ input }) => {
        // input is { query: string }
        void (input.query as string);
        return { result: input.query };
      });

    expect(skill).toBeDefined();
  });

  test('define callback rejects wrong input type', () => {
    Skill.of()
      .input(S.Struct({ query: S.String }))
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(({ input }) => {
        // @ts-expect-error - input.query is string, not number
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _: number = input.query;
        return { result: input.query };
      });
  });

  test('define callback receives typed emit', () => {
    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.Struct({ text: S.String }))
      .done(S.Struct({ r: S.String }))
      .define(({ emit }) => {
        emit({ text: 'chunk' });
        return { r: 'done' };
      });

    expect(skill).toBeDefined();
  });

  test('define callback receives typed layers from use()', () => {
    const myLayerFoo = DepedencyLayer.of({
      name: 'myLayerFoo',
      shape: S.Struct({ foo: S.String }),
    });

    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.String)
      .done(S.Struct({ r: S.String }))
      .dependsOn(myLayerFoo)
      .define(({ layers }) => {
        void (layers.myLayerFoo.foo as string);
        return { r: layers.myLayerFoo.foo };
      });

    expect(skill).toBeDefined();
  });

  test('define callback rejects wrong layers property', () => {
    const myLayerFoo = DepedencyLayer.of({
      name: 'myLayerFoo',
      shape: S.Struct({ foo: S.String }),
    });

    Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.String)
      .done(S.Struct({ r: S.String }))
      .dependsOn(myLayerFoo)
      .define(({ layers }) => {
        // @ts-expect-error - layers has myLayerFoo, not nonexistent
        const _: string = layers.nonexistent;
        void _;
        return { r: 'x' };
      });
  });

  test('define callback return is typed from done schema', () => {
    Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(() => ({
        result: 'ok',
      }));
  });

  test('invoke return type is { chunks: TChunk[]; done: TDone }', async () => {
    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.Number)
      .done(S.Struct({ total: S.Number }))
      .define(({ emit }) => {
        emit(1);
        emit(2);
        return { total: 3 };
      });

    const result = await skill.invoke({ q: 'x' });

    const _chunks: number[] = result.chunks;
    const _done: { total: number } = result.done;
    expect(_chunks).toEqual([1, 2]);
    expect(_done).toEqual({ total: 3 });
  });

  test('SkillInstance has correct invoke signature', () => {
    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.String)
      .done(S.Struct({ r: S.String }))
      .define(({ input }) => ({ r: input.q }));

    const instance: SkillInstance<
      { q: string },
      string,
      { r: string },
      Record<string, never>
    > = skill;
    expect(instance.invoke).toBeDefined();
  });
});
