import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vitest } from 'vitest';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import { DepedencyLayer } from './dependency-layer.js';
import { AgentToolCollection, Tool, type ToolDefinition } from './tool.js';

describe('Tool', () => {
  test('creates tool definition with schema and dependency layers', () => {
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();

    const findUser = Tool.of({ name: 'findUser', description: 'Find a user by id' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .dependsOn(dbLayer)
      .define(async ({ input, layers, toolCallId }) => {
        expectTypeOf(input).toEqualTypeOf({} as { readonly id: string });
        expectTypeOf(layers.Db.config).toEqualTypeOf({} as { readonly url: string });
        expectTypeOf(layers.Db.query).toEqualTypeOf(async (_sql: string): Promise<string> => '');
        expectTypeOf(toolCallId).toEqualTypeOf('' as string);
        const name = await layers.Db.query(input.id);
        return { name };
      });

    expect(findUser.schema.name).toBe('findUser');
    expect(findUser.schema.description).toBe('Find a user by id');
    expect(findUser.dependencyLayers).toEqual([dbLayer]);
  });

  test('bound tool decodes input and output', async () => {
    const query = vitest.fn(async () => 'Ada');
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();

    const findUser = Tool.of({ name: 'findUser', description: 'Find a user by id' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .dependsOn(dbLayer)
      .define(async ({ input, layers }) => {
        const name = await layers.Db.query(input.id);
        return { name };
      });

    const bound = findUser.bind({
      layers: {
        Db: {
          config: { url: 'memory' },
          query,
        },
      },
    });

    await expect(bound.execute({ id: 123 })).rejects.toThrow();
    await expect(bound.execute({ id: 'user-1' })).resolves.toEqual({ name: 'Ada' });
    expect(query).toHaveBeenCalledWith('user-1');
  });

  test('bound tool validates output', async () => {
    const tool = Tool.of({ name: 'badTool', description: 'Returns invalid output' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .define(() => ({ name: 123 }) as unknown as { name: string });

    await expect(tool.bind({ layers: {} }).execute({ id: 'user-1' })).rejects.toThrow();
  });

  test('bound tool receives injected emit as a side effect without changing output', async () => {
    const ToolUsed = AgentNetworkEvent.of(
      'tool-used',
      S.Struct({
        toolCallId: S.String,
        toolName: S.String,
        phase: S.Literal('start', 'end'),
      }),
    );
    const emit = vitest.fn();
    const toolCallIds: string[] = [];

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ text: S.String }))
      .define(({ input, emit, toolCallId }) => {
        toolCallIds.push(toolCallId);
        emit(ToolUsed.make({ toolCallId, toolName: 'echo', phase: 'start' }));
        return input;
      });

    const bound = tool.bind({ layers: {}, emit });

    await expect(bound.execute({ text: 'hello' })).resolves.toEqual({ text: 'hello' });
    await expect(bound.execute({ text: 'again' })).resolves.toEqual({ text: 'again' });
    expect(tool.emitEvents).toEqual([ToolUsed]);
    expect(toolCallIds).toHaveLength(2);
    expect(toolCallIds[0]).toEqual(expect.any(String));
    expect(toolCallIds[1]).toEqual(expect.any(String));
    expect(toolCallIds[0]).not.toBe(toolCallIds[1]);
    expect(emit).toHaveBeenNthCalledWith(1, {
      name: 'tool-used',
      payload: { toolCallId: toolCallIds[0], toolName: 'echo', phase: 'start' },
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      name: 'tool-used',
      payload: { toolCallId: toolCallIds[1], toolName: 'echo', phase: 'start' },
    });
  });

  test('bound tool receives injected emitAndAwait', async () => {
    const ToolUsed = AgentNetworkEvent.of('tool-used', S.Struct({ text: S.String }));
    const reply = {
      name: 'tool-result',
      meta: { runId: 'run-1', contextId: 'ctx-1', correlationId: 'corr-1' },
      payload: { ok: true },
    };
    const emitAndAwait = vitest.fn(async () => reply);

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ ok: S.Boolean }))
      .define(async ({ input, emitAndAwait }) => {
        const result = await emitAndAwait(
          ToolUsed.make({ text: input.text }),
          (event) => event.name === 'tool-result',
          { timeout: '10 millis' },
        );
        return result.payload as { ok: boolean };
      });

    const bound = tool.bind({ layers: {}, emitAndAwait });

    await expect(bound.execute({ text: 'hello' })).resolves.toEqual({ ok: true });
    expect(emitAndAwait).toHaveBeenCalledWith(
      { name: 'tool-used', payload: { text: 'hello' } },
      expect.any(Function),
      { timeout: '10 millis' },
    );
  });

  test('default tool emitAndAwait rejects when unbound', async () => {
    const ToolUsed = AgentNetworkEvent.of('tool-used', S.Struct({ text: S.String }));

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ ok: S.Boolean }))
      .define(async ({ input, emitAndAwait }) => {
        await emitAndAwait(ToolUsed.make({ text: input.text }), (event) => event.name === 'done');
        return { ok: true };
      });

    await expect(tool.bind({ layers: {} }).execute({ text: 'hello' })).rejects.toThrow(
      'emitAndAwait is only available when the tool is running in an event plane',
    );
  });

  test('define throws when input or output schema is missing', () => {
    expect(() =>
      Tool.of({ name: 'badTool', description: 'Incomplete tool' }).define(() => null),
    ).toThrow(/Tool\.define requires input\(\) and output\(\)/);
  });

  test('throws on duplicate layer names', () => {
    const layer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({}),
    });

    expect(() =>
      Tool.of({ name: 'findUser', description: 'Find a user by id' })
        .input(S.Struct({ id: S.String }))
        .output(S.Struct({ name: S.String }))
        .dependsOn(layer)
        .dependsOn(layer)
        .define(() => ({ name: 'Ada' })),
    ).toThrow(/Duplicate layer name: Db/);
  });
});

describe('AgentToolCollection', () => {
  test('exposes raw schemas and dependency-injected tools', async () => {
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();

    const findUser = Tool.of({ name: 'findUser', description: 'Find a user by id' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .dependsOn(dbLayer)
      .define(async ({ input, layers }) => {
        const name = await layers.Db.query(input.id);
        return { name };
      });

    const collection = new AgentToolCollection<typeof findUser, typeof dbLayer, never>(
      [findUser],
      {
        Db: {
          config: { url: 'memory' },
          query: async () => 'Ada',
        },
      },
      () => {},
    );

    expect(collection.toToolSchemas()).toEqual([findUser.schema]);
    await expect(collection.toTools()[0]?.execute({ id: 'user-1' })).resolves.toEqual({
      name: 'Ada',
    });
    expectTypeOf(collection.toToolSchemas()[0]).toEqualTypeOf(findUser.schema);
  });

  test('ToolDefinition type captures executable tool shape', () => {
    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ text: S.String }))
      .define(({ input }) => input);

    const definition: ToolDefinition<{ text: string }, { text: string }, never> = tool;
    expect(definition.schema.name).toBe('echo');
  });
});
