import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { AgentFactory } from './agent-factory.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import { DepedencyLayer } from './dependency-layer.js';
import { Tool } from './tool.js';

describe('AgentFactory', () => {
  test('should create an agent that works with basic setup', () => {
    const agentFactory = AgentFactory.run();
    expect(agentFactory).toBeDefined();
  });

  test('listensTo accumulates event types', () => {
    const AddTask = AgentNetworkEvent.of('add-task', S.Struct({ title: S.String }));
    const RemoveTask = AgentNetworkEvent.of('remove-task', S.Struct({ id: S.String }));

    const factory = AgentFactory.run().listensTo([AddTask, RemoveTask]);

    const events = factory.getListensTo();
    expect(events).toHaveLength(2);
    expect(events[0]?.name).toBe('add-task');
    expect(events[1]?.name).toBe('remove-task');
  });

  test('emits accumulates event types', () => {
    const TaskAdded = AgentNetworkEvent.of('task-added', S.Struct({ title: S.String }));
    const TaskRemoved = AgentNetworkEvent.of('task-removed', S.Struct({ id: S.String }));

    const factory = AgentFactory.run().emits([TaskAdded, TaskRemoved]);

    const events = factory.getEmits();
    expect(events).toHaveLength(2);
    expect(events[0]?.name).toBe('task-added');
    expect(events[1]?.name).toBe('task-removed');
  });

  test('logic receives triggerEvent and emit function', () => {
    const AddTask = AgentNetworkEvent.of('add-task', S.Struct({ title: S.String }));
    const RemoveTask = AgentNetworkEvent.of('remove-task', S.Struct({ id: S.String }));
    const TaskAdded = AgentNetworkEvent.of('task-added', S.Struct({ title: S.String }));

    const factory = AgentFactory.run()
      .listensTo([AddTask, RemoveTask])
      .emits([TaskAdded])
      .logic(({ triggerEvent, emit }) => {
        expectTypeOf(triggerEvent.name).toEqualTypeOf<'add-task' | 'remove-task'>();
        expectTypeOf(emit).parameters.toEqualTypeOf<[ReturnType<typeof TaskAdded.make>]>();

        if (triggerEvent.name === 'add-task') {
          emit(TaskAdded.make({ title: triggerEvent.payload.title }));
        }

        // @ts-expect-error - emit is typed to only accept TaskAdded envelopes
        emit(RemoveTask.make({ id: '1' }));

        return Promise.resolve();
      });

    const agent = factory.produce({});
    expect(agent).toBeDefined();
  });

  test('params infers logic params and produce input', () => {
    const paramsSchema = S.Struct({
      maxLoops: S.Number,
      model: S.String,
    });

    const factory = AgentFactory.run()
      .params(paramsSchema)
      .logic(({ params }) => {
        expectTypeOf(params).toEqualTypeOf(paramsSchema.Type);
        return Promise.resolve();
      });

    const agent = factory.produce({ maxLoops: 3, model: 'gpt-4o' });

    // @ts-expect-error - produce is typed from params()
    factory.produce({ maxLoops: '3', model: 'gpt-4o' });

    expect(agent).toBeDefined();
  });

  test('dependsOn infers layers and accumulates dependency definitions', () => {
    const openAiConfig = S.Struct({ model: S.String });
    const openAiLayer = DepedencyLayer.of({
      name: 'OpenAi',
      config: openAiConfig,
    }).define<{ client: { complete: (prompt: string) => Promise<string> } }>();

    const factory = AgentFactory.run()
      .dependsOn(openAiLayer)
      .logic(({ layers }) => {
        const openAi = layers.OpenAi;
        expectTypeOf(openAi.config).toEqualTypeOf(openAiConfig.Type);
        expectTypeOf(openAi.client.complete).parameters.toEqualTypeOf<[string]>();
        return Promise.resolve();
      });

    const layers = factory.getDependencyLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0]?._name).toBe('OpenAi');
  });

  test('dependsOn throws on duplicate layer names', () => {
    const layer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({}),
    });

    expect(() => AgentFactory.run().dependsOn(layer).dependsOn(layer)).toThrow(
      /Duplicate layer name: Db/,
    );
  });

  test('produce retains listened event names and dependency layers', () => {
    const taskRequested = AgentNetworkEvent.of('task-requested', S.Struct({ title: S.String }));
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    });

    const agent = AgentFactory.run()
      .dependsOn(dbLayer)
      .listensTo([taskRequested])
      .logic(() => Promise.resolve())
      .produce({});

    expect(agent.getListensTo()).toEqual(['task-requested']);
    expect(agent.getDependencyLayers()).toEqual([dbLayer]);
  });

  test('tools accumulates tool definitions and promotes dependency layers', () => {
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

    const factory = AgentFactory.run()
      .tools(findUser)
      .logic(({ tools }) => {
        expect(tools.toToolSchemas()).toHaveLength(1);
        expect(tools.toTools()[0]?.execute).toBeDefined();
        expectTypeOf(tools.toToolSchemas()[0]).toEqualTypeOf(findUser.schema);
        return Promise.resolve();
      });

    expect(factory.getTools()).toEqual([findUser]);
    expect(factory.getDependencyLayers()).toEqual([dbLayer]);
  });

  test('tools deduplicates shared dependency layers across multiple tools', () => {
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();

    const toolA = Tool.of({ name: 'toolA', description: 'A' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ ok: S.Boolean }))
      .dependsOn(dbLayer)
      .define(async () => ({ ok: true }));

    const toolB = Tool.of({ name: 'toolB', description: 'B' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ ok: S.Boolean }))
      .dependsOn(dbLayer)
      .define(async () => ({ ok: true }));

    const factory = AgentFactory.run().tools([toolA, toolB]);

    expect(factory.getDependencyLayers()).toEqual([dbLayer]);
  });

  test('tools retain emitted event metadata', () => {
    const ToolUsed = AgentNetworkEvent.of(
      'tool-used',
      S.Struct({ toolName: S.String, phase: S.Literal('start', 'end') }),
    );

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ text: S.String }))
      .define(({ input }) => input);

    const factory = AgentFactory.run().tools(tool);

    expect(factory.getTools()[0]?.emitEvents).toEqual([ToolUsed]);
  });

  test('builder methods return new factories without mutating previous instances', () => {
    const taskRequested = AgentNetworkEvent.of('task-requested', S.Struct({ title: S.String }));
    const taskCreated = AgentNetworkEvent.of('task-created', S.Struct({ title: S.String }));
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({}),
    });

    const base = AgentFactory.run();
    const withParams = base.params(S.Struct({ userId: S.String }));
    const withListensTo = withParams.listensTo([taskRequested]);
    const withEmits = withListensTo.emits([taskCreated]);
    const withDeps = withEmits.dependsOn(dbLayer);

    expect(base.getListensTo()).toEqual([]);
    expect(base.getEmits()).toEqual([]);
    expect(base.getDependencyLayers()).toEqual([]);
    expect(withParams.getListensTo()).toEqual([]);
    expect(withListensTo.getListensTo()).toEqual([taskRequested]);
    expect(withListensTo.getEmits()).toEqual([]);
    expect(withEmits.getEmits()).toEqual([taskCreated]);
    expect(withEmits.getDependencyLayers()).toEqual([]);
    expect(withDeps.getDependencyLayers()).toEqual([dbLayer]);
  });

  test('combined builder chain preserves params, events, emits, and layers inference', () => {
    const paramsSchema = S.Struct({ tenantId: S.String });
    const taskRequested = AgentNetworkEvent.of('task-requested', S.Struct({ title: S.String }));
    const taskCreated = AgentNetworkEvent.of('task-created', S.Struct({ id: S.String }));
    const dbConfig = S.Struct({ url: S.String });
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: dbConfig,
    }).define<{ pool: { query: (sql: string) => Promise<unknown> } }>();

    const factory = AgentFactory.run()
      .params(paramsSchema)
      .dependsOn(dbLayer)
      .listensTo([taskRequested])
      .emits([taskCreated])
      .logic(({ params, triggerEvent, emit, layers }) => {
        expectTypeOf(params).toEqualTypeOf(paramsSchema.Type);
        expectTypeOf(triggerEvent.name).toEqualTypeOf<'task-requested'>();
        expectTypeOf(triggerEvent.payload).toEqualTypeOf(taskRequested.payload.Type);
        expectTypeOf(emit).parameters.toEqualTypeOf<[ReturnType<typeof taskCreated.make>]>();
        expectTypeOf(layers.Db.config).toEqualTypeOf(dbConfig.Type);
        expectTypeOf(layers.Db.pool.query).parameters.toEqualTypeOf<[string]>();

        emit(taskCreated.make({ id: `${params.tenantId}:${triggerEvent.payload.title}` }));
        return Promise.resolve();
      });

    const agent = factory.produce({ tenantId: 'tenant-1' });
    expect(agent.getListensTo()).toEqual(['task-requested']);
  });
});
