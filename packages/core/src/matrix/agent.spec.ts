import { describe, expect, test, vitest } from 'vitest';
import { Schema as S } from 'effect';
import { AgentFactory } from './agent-factory';
import { AgentNetworkEvent } from './agent-network/agent-network-event';

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

    const TaskAdded = AgentNetworkEvent.of(
      'task-added',
      S.Struct({ title: S.String }),
    );

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

    const TaskRequested = AgentNetworkEvent.of(
      'task-requested',
      S.Struct({ title: S.String }),
    );

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

    const TaskAdded = AgentNetworkEvent.of(
      'task-added',
      S.Struct({ title: S.String }),
    );

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
});
