import { Schema as S } from 'effect';
import { describe, expect, test, vitest } from 'vitest';
import { AgentFactory } from './agent-factory.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import { DepedencyLayer } from './dependency-layer.js';
import { Tool } from './tool.js';

describe('Agent', () => {
  test('should invoke logic with params', async () => {
    const spy = vitest.fn();

    const paramsSchema = S.Struct({ maxLoops: S.Number });

    const agent = AgentFactory.run()
      .params(paramsSchema)
      .logic(({ params }) => {
        for (let i = 0; i < params.maxLoops; i++) {
          spy();
        }
        return Promise.resolve();
      })
      .produce({ maxLoops: 3 });

    await agent.invoke();

    expect(spy).toHaveBeenCalledTimes(3);
  });

  test('emit function is available in logic context', async () => {
    const emitSpy = vitest.fn();

    const TaskAdded = AgentNetworkEvent.of('task-added', S.Struct({ title: S.String }));

    const agent = AgentFactory.run()
      .emits([TaskAdded])
      .logic(({ emit }) => {
        emitSpy(emit);
        return Promise.resolve();
      })
      .produce({});

    await agent.invoke();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(typeof emitSpy.mock.calls[0][0]).toBe('function');
  });

  test('invoke accepts a triggerEvent', async () => {
    const triggerSpy = vitest.fn();

    const TaskRequested = AgentNetworkEvent.of('task-requested', S.Struct({ title: S.String }));

    const agent = AgentFactory.run()
      .listensTo([TaskRequested])
      .logic(({ triggerEvent }) => {
        triggerSpy(triggerEvent);
        return Promise.resolve();
      })
      .produce({});

    const event = TaskRequested.makeBound(
      { runId: 'run-1', contextId: 'ctx-1' },
      { title: 'Do stuff' },
    );
    await agent.invoke({ triggerEvent: event });

    expect(triggerSpy).toHaveBeenCalledWith(event);
  });

  test('invoke accepts a custom emit function', async () => {
    const customEmit = vitest.fn();

    const TaskAdded = AgentNetworkEvent.of('task-added', S.Struct({ title: S.String }));

    const agent = AgentFactory.run()
      .emits([TaskAdded])
      .logic(({ emit }) => {
        emit({
          name: 'task-added',
          payload: { title: 'hello' },
        });
        return Promise.resolve();
      })
      .produce({});

    await agent.invoke({ emit: customEmit });

    expect(customEmit).toHaveBeenCalledWith({
      name: 'task-added',
      payload: { title: 'hello' },
    });
  });

  test('invoke accepts a custom emitAndAwait function', async () => {
    const TaskAdded = AgentNetworkEvent.of('task-added', S.Struct({ title: S.String }));
    const reply = {
      name: 'task-done',
      meta: { runId: 'run-1', contextId: 'ctx-1', correlationId: 'corr-1' },
      payload: { ok: true },
    };
    const emitAndAwait = vitest.fn(async () => reply);
    const resultSpy = vitest.fn();

    const agent = AgentFactory.run()
      .emits([TaskAdded])
      .logic(async ({ emitAndAwait }) => {
        const result = await emitAndAwait(
          { name: 'task-added', payload: { title: 'hello' } },
          (event) => event.name === 'task-done',
          { timeout: '10 millis' },
        );
        resultSpy(result);
      })
      .produce({});

    await agent.invoke({ emitAndAwait });

    expect(emitAndAwait).toHaveBeenCalledWith(
      { name: 'task-added', payload: { title: 'hello' } },
      expect.any(Function),
      { timeout: '10 millis' },
    );
    expect(resultSpy).toHaveBeenCalledWith(reply);
  });

  test('default emitAndAwait rejects outside a running network', async () => {
    const TaskAdded = AgentNetworkEvent.of('task-added', S.Struct({ title: S.String }));
    const errorSpy = vitest.fn();

    const agent = AgentFactory.run()
      .emits([TaskAdded])
      .logic(async ({ emitAndAwait }) => {
        try {
          await emitAndAwait(
            { name: 'task-added', payload: { title: 'hello' } },
            (event) => event.name === 'task-done',
          );
        } catch (error) {
          errorSpy(error);
        }
      })
      .produce({});

    await agent.invoke();

    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(errorSpy.mock.calls[0][0]).toMatchObject({
      message: 'emitAndAwait is only available when the agent is running in an event plane',
    });
  });

  test('invoke provides dependency-injected tool collection to logic', async () => {
    const dbLayer = DepedencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();
    const query = vitest.fn(async () => 'Ada');
    const resultSpy = vitest.fn();

    const findUser = Tool.of({ name: 'findUser', description: 'Find a user by id' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .dependsOn(dbLayer)
      .define(async ({ input, layers }) => {
        const name = await layers.Db.query(input.id);
        return { name };
      });

    const agent = AgentFactory.run()
      .tools(findUser)
      .logic(async ({ tools }) => {
        expect(tools.toToolSchemas()).toEqual([findUser.schema]);
        const [tool] = tools.toTools();
        resultSpy(await tool?.execute({ id: 'user-1' }));
      })
      .produce({});

    await agent.invoke({
      layers: {
        Db: {
          config: { url: 'memory' },
          query,
        },
      },
    });

    expect(query).toHaveBeenCalledWith('user-1');
    expect(resultSpy).toHaveBeenCalledWith({ name: 'Ada' });
  });

  test('invoke injects its emit function into bound tools', async () => {
    const emit = vitest.fn();
    const ToolUsed = AgentNetworkEvent.of(
      'tool-used',
      S.Struct({
        toolCallId: S.String,
        toolName: S.String,
        phase: S.Literal('start', 'end'),
      }),
    );

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ text: S.String }))
      .define(({ input, emit, toolCallId }) => {
        emit(ToolUsed.make({ toolCallId, toolName: 'echo', phase: 'start' }));
        return input;
      });

    const agent = AgentFactory.run()
      .emits([ToolUsed])
      .tools(tool)
      .logic(async ({ tools }) => {
        const [boundTool] = tools.toTools();
        await boundTool?.execute({ text: 'hello' });
      })
      .produce({});

    await agent.invoke({ emit });

    expect(emit).toHaveBeenCalledWith({
      name: 'tool-used',
      payload: {
        toolCallId: expect.any(String),
        toolName: 'echo',
        phase: 'start',
      },
    });
  });
});
