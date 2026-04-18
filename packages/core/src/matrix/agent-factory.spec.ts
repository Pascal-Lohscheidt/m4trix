import { describe, expect, expectTypeOf, test } from 'vitest';
import { Schema as S } from 'effect';
import { AgentFactory } from './agent-factory.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';

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
});
