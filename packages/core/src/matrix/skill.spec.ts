import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { DepedencyLayer } from './dependency-layer.js';
import { Done, Skill, type SkillInstance } from './skill.js';

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

    expect(results).toEqual([1, 2, Done.of({ sum: 13 })]);
    expect(Done.is(results[2])).toBe(true);
    expect(Done.is(results[0])).toBe(false);
  });

  test('use accepts single layer', async () => {
    type DepType = { bar: string };
    const myLayer = DepedencyLayer.of({
      name: 'MyLayerFoo',
      config: S.Struct({ foo: S.String }),
    }).define<DepType>();

    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.String)
      .done(S.Struct({ r: S.String }))
      .dependsOn(myLayer)
      .define(({ input, layers }) => {
        const { config } = layers.MyLayerFoo;
        expect(config).toEqual({ foo: 'bar' });
        return { r: input.q + config.foo };
      });

    const { done } = await skill.invoke(
      { q: 'prefix-' },
      { layers: { MyLayerFoo: { bar: 'test', config: { foo: 'bar' } } } },
    );
    expect(done).toEqual({ r: 'prefix-bar' });
  });

  test('use accepts array of layers (same type)', async () => {
    const layer = DepedencyLayer.of({
      name: 'LayerA',
      config: S.Struct({ a: S.Number }),
    });

    const skill = Skill.of()
      .input(S.Struct({ x: S.Number }))
      .chunk(S.String)
      .done(S.Struct({ out: S.String }))
      .dependsOn([layer])
      .define(({ layers }) => {
        const { config } = layers.LayerA;
        return { out: `${config.a}` };
      });

    const { done } = await skill.invoke({ x: 1 }, { layers: { LayerA: { config: { a: 42 } } } });
    expect(done).toEqual({ out: '42' });
  });

  test('use accepts multiple layers via chaining', async () => {
    const layerA = DepedencyLayer.of({
      name: 'LayerA',
      config: S.Struct({ a: S.Number }),
    });
    const layerB = DepedencyLayer.of({
      name: 'LayerB',
      config: S.Struct({ b: S.String }),
    });

    const skill = Skill.of()
      .input(S.Struct({ x: S.Number }))
      .chunk(S.String)
      .done(S.Struct({ out: S.String }))
      .dependsOn(layerA)
      .dependsOn(layerB)
      .define(({ layers }) => {
        const { config: configA } = layers.LayerA;
        const { config: configB } = layers.LayerB;
        return { out: `${configA.a}-${configB.b}` };
      });

    const { done } = await skill.invoke(
      { x: 1 },
      {
        layers: {
          LayerA: { config: { a: 99 } },
          LayerB: { config: { b: 'world' } },
        },
      },
    );
    expect(done).toEqual({ out: '99-world' });
  });

  test('throws on duplicate layer names', () => {
    const layer = DepedencyLayer.of({
      name: 'Dup',
      config: S.Struct({ x: S.Number }),
    });

    expect(() =>
      Skill.of()
        .input(S.Struct({ q: S.String }))
        .chunk(S.String)
        .done(S.Struct({ r: S.String }))
        .dependsOn(layer)
        .dependsOn(layer)
        .define(() => ({ r: 'x' })),
    ).toThrow(/Duplicate layer name: Dup/);
  });

  test('define throws when input/chunk/done not called', () => {
    expect(() => Skill.of().define(() => ({ r: 'x' }))).toThrow(/Skill.define requires input\(\)/);
  });

  test('invoke decodes input and validates', async () => {
    const skill = Skill.of()
      .input(S.Struct({ query: S.String }))
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(({ input }) => ({ result: input.query }));

    await expect(skill.invoke({ wrongKey: 123 } as unknown as { query: string })).rejects.toThrow();
  });
});

describe('Skill type tests', () => {
  test('define callback receives typed input', () => {
    const inputShape = S.Struct({ query: S.String });
    const skill = Skill.of()
      .input(inputShape)
      .chunk(S.String)
      .done(S.Struct({ result: S.String }))
      .define(({ input }) => {
        expectTypeOf(input).toEqualTypeOf(inputShape.Type);
        return { result: input.query };
      });

    expect(skill).toBeDefined();
  });

  test('define callback receives typed emit', () => {
    const chunkShape = S.Struct({ text: S.String });
    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(chunkShape)
      .done(S.Struct({ r: S.String }))
      .define(({ emit }) => {
        expectTypeOf(emit).parameters.toEqualTypeOf<[typeof chunkShape.Type]>();
        emit({ text: 'chunk' });
        return { r: 'done' };
      });

    expect(skill).toBeDefined();
  });

  test('define callback receives typed layers from use()', () => {
    type LayerDepType = { bar: string };
    const layerConfigShape = S.Struct({ foo: S.String });
    const myLayerFoo = DepedencyLayer.of({
      name: 'MyLayerFoo',
      config: layerConfigShape,
    }).define<LayerDepType>();

    const skill = Skill.of()
      .input(S.Struct({ q: S.String }))
      .chunk(S.String)
      .done(S.Struct({ r: S.String }))
      .dependsOn(myLayerFoo)
      .define(({ layers }) => {
        const layerValue = layers.MyLayerFoo;
        expectTypeOf(layers).toHaveProperty('MyLayerFoo');
        expectTypeOf(layerValue.config).toEqualTypeOf(layerConfigShape.Type);
        expectTypeOf(layerValue).toEqualTypeOf<
          LayerDepType & { config: typeof layerConfigShape.Type }
        >();
        const { config } = layers.MyLayerFoo;
        return { r: config.foo };
      });

    expect(skill).toBeDefined();
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
