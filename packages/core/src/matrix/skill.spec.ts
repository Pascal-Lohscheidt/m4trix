import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { DependencyLayer } from './dependency-layer.js';
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
    expect(Object.getOwnPropertySymbols(results[2])).toContain(Symbol.for('m4trix/Done'));
  });

  test('use accepts single layer', async () => {
    type DepType = { bar: string };
    const myLayer = DependencyLayer.of({
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
    const layer = DependencyLayer.of({
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
    const layerA = DependencyLayer.of({
      name: 'LayerA',
      config: S.Struct({ a: S.Number }),
    });
    const layerB = DependencyLayer.of({
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
    const layer = DependencyLayer.of({
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
    const myLayerFoo = DependencyLayer.of({
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

describe('Skill signal', () => {
  const echo = Skill.of()
    .input(S.Struct({ text: S.String }))
    .chunk(S.String)
    .done(S.String)
    .define(({ input, signal }) => {
      expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
      return signal.aborted ? 'aborted' : input.text;
    });

  test('define receives the runtime signal', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const probe = Skill.of()
      .input(S.Struct({}))
      .chunk(S.String)
      .done(S.Boolean)
      .define(({ signal }) => {
        seen = signal;
        return true;
      });

    await probe.invoke({}, { layers: {}, signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });

  test('invoke without a signal runs with one that never aborts', async () => {
    await expect(echo.invoke({ text: 'hi' })).resolves.toEqual({ chunks: [], done: 'hi' });
  });

  test('invoke and invokeStream reject when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('gone'));

    await expect(
      echo.invoke({ text: 'hi' }, { layers: {}, signal: controller.signal }),
    ).rejects.toThrow('gone');
    const stream = echo.invokeStream({ text: 'hi' }, { layers: {}, signal: controller.signal });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('gone');
  });
});

describe('Skill invokeStream streaming', () => {
  const deferred = <T = void>() => {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const pendingMarker = Symbol('pending');
  const settleSoon = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<typeof pendingMarker>((r) => setTimeout(r, 50, pendingMarker)),
    ]);

  test('yields each chunk as soon as it is emitted, before define resolves', async () => {
    const gate = deferred();
    const skill = Skill.of()
      .input(S.Struct({}))
      .chunk(S.String)
      .done(S.Number)
      .define(async ({ emit }) => {
        emit('first');
        await gate.promise;
        emit('second');
        return 2;
      });

    const iterator = skill.invokeStream({})[Symbol.asyncIterator]();

    await expect(settleSoon(iterator.next())).resolves.toEqual({ done: false, value: 'first' });
    const next = iterator.next();
    await expect(settleSoon(next)).resolves.toBe(pendingMarker);
    gate.resolve();
    await expect(next).resolves.toEqual({ done: false, value: 'second' });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: Done.of(2) });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('an error thrown in define reaches the consumer after the chunks before it', async () => {
    const skill = Skill.of()
      .input(S.Struct({}))
      .chunk(S.String)
      .done(S.Number)
      .define(async ({ emit }) => {
        emit('partial');
        await Promise.resolve();
        throw new Error('model failed');
      });

    const seen: unknown[] = [];
    const consume = async () => {
      for await (const item of skill.invokeStream({})) seen.push(item);
    };

    await expect(consume()).rejects.toThrow('model failed');
    expect(seen).toEqual(['partial']);
  });

  test('an invalid chunk or done value surfaces to the consumer', async () => {
    const badChunk = Skill.of()
      .input(S.Struct({}))
      .chunk(S.String)
      .done(S.Number)
      .define(({ emit }) => {
        emit(1 as unknown as string);
        return 1;
      });
    const badDone = Skill.of()
      .input(S.Struct({}))
      .chunk(S.String)
      .done(S.Number)
      .define(() => 'nope' as unknown as number);

    const drain = async (stream: AsyncIterable<unknown>) => {
      for await (const _ of stream) {
        // consume
      }
    };
    await expect(drain(badChunk.invokeStream({}))).rejects.toThrow(/Expected string/);
    await expect(drain(badDone.invokeStream({}))).rejects.toThrow(/Expected number/);
  });

  test('stopping iteration early aborts the skill signal but not the caller signal', async () => {
    const callerController = new AbortController();
    const stopped = deferred<boolean>();
    const skill = Skill.of()
      .input(S.Struct({}))
      .chunk(S.Number)
      .done(S.Number)
      .define(async ({ emit, signal }) => {
        emit(1);
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        stopped.resolve(signal.aborted);
        emit(2);
        return 2;
      });

    for await (const item of skill.invokeStream(
      {},
      { layers: {}, signal: callerController.signal },
    )) {
      expect(item).toBe(1);
      break;
    }

    await expect(stopped.promise).resolves.toBe(true);
    expect(callerController.signal.aborted).toBe(false);
  });

  test('aborting the caller signal mid-stream aborts the skill signal', async () => {
    const controller = new AbortController();
    let skillSignal: AbortSignal | undefined;
    const skill = Skill.of()
      .input(S.Struct({}))
      .chunk(S.String)
      .done(S.String)
      .define(({ emit, signal }) => {
        skillSignal = signal;
        emit('started');
        return new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      });

    const iterator = skill
      .invokeStream({}, { layers: {}, signal: controller.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'started' });
    controller.abort(new Error('cancelled'));

    await expect(iterator.next()).rejects.toThrow('cancelled');
    expect(skillSignal?.aborted).toBe(true);
  });
});
