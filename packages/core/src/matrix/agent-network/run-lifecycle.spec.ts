import { Effect, Queue, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vitest } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { ChannelName } from '../identifiers/channel-name.js';
import type { SseProxyConsumerOptions } from '../io/proxy-consumer.js';
import {
  AgentNetwork,
  type AgentNetworkSetupContext,
  type AgentNetworkSetupOptions,
} from './agent-network.js';
import { AgentNetworkEvent, type EventMeta } from './agent-network-event.js';
import { createEventPlane } from './event-plane.js';
import {
  type AgentErrorPolicy,
  isReservedEventName,
  isRunEndEnvelope,
  isRunLifecycleEnvelope,
  outcomeError,
  RunCancelledError,
  type RunEndEnvelope,
  RunLifecycleEvent,
  serializeError,
} from './run-lifecycle.js';

const meta: EventMeta = { runId: 'run-1', contextId: 'ctx-1' };

describe('run lifecycle events', () => {
  test('names use the reserved m4trix: prefix', () => {
    expect(RunLifecycleEvent).toEqual({
      completed: 'm4trix:run.completed',
      failed: 'm4trix:run.failed',
      cancelled: 'm4trix:run.cancelled',
      agentError: 'm4trix:agent.error',
    });
    for (const name of Object.values(RunLifecycleEvent)) {
      expect(isReservedEventName(name)).toBe(true);
    }
    expect(isReservedEventName('answer')).toBe(false);
  });

  test('isRunEndEnvelope matches the three run-end events only', () => {
    const envelope = (name: string) => ({ name, meta, payload: {} });

    expect(isRunEndEnvelope(envelope(RunLifecycleEvent.completed))).toBe(true);
    expect(isRunEndEnvelope(envelope(RunLifecycleEvent.failed))).toBe(true);
    expect(isRunEndEnvelope(envelope(RunLifecycleEvent.cancelled))).toBe(true);
    expect(isRunEndEnvelope(envelope(RunLifecycleEvent.agentError))).toBe(false);
    expect(isRunEndEnvelope(envelope('answer'))).toBe(false);
    expect(isRunLifecycleEnvelope(envelope(RunLifecycleEvent.agentError))).toBe(true);
    expect(isRunLifecycleEnvelope(envelope('answer'))).toBe(false);
  });

  test('isRunEndEnvelope narrows to the typed run-end payloads', () => {
    const envelope: { name: string; meta: EventMeta; payload: unknown } = {
      name: RunLifecycleEvent.failed,
      meta,
      payload: { error: { name: 'Error', message: 'x', kind: 'agent-error' } },
    };
    if (isRunEndEnvelope(envelope)) {
      expectTypeOf(envelope).toMatchTypeOf<RunEndEnvelope>();
      if (envelope.name === RunLifecycleEvent.failed) {
        expectTypeOf(envelope.payload.error.kind).toEqualTypeOf<
          | 'agent-error'
          | 'idle-timeout'
          | 'max-duration'
          | 'limit-exceeded'
          | 'store-error'
          | 'invalid-emit'
          | 'run-unavailable'
          | 'stream-error'
        >();
      }
    }
  });

  test('AgentNetworkEvent.of rejects the reserved prefix', () => {
    expect(() => AgentNetworkEvent.of('m4trix:run.completed', S.Struct({}))).toThrow(
      /reserved "m4trix:" prefix/,
    );
  });

  test('serializeError keeps name and message only', () => {
    const error = Object.assign(new RangeError('too big'), { secret: 'token' });

    expect(serializeError(error)).toEqual({ name: 'RangeError', message: 'too big' });
    expect(serializeError('plain')).toEqual({ name: 'Error', message: 'plain' });
    expect(serializeError({ code: 1 })).toEqual({ name: 'Error', message: '[object Object]' });
  });

  test('outcomeError maps outcomes to tracer errors', () => {
    const boom = new Error('boom');

    expect(
      outcomeError({ status: 'completed', payload: { reason: 'agent', agentId: 'a' } }),
    ).toBeUndefined();
    expect(
      outcomeError({
        status: 'failed',
        error: boom,
        payload: { error: { name: 'Error', message: 'boom', kind: 'agent-error' } },
      }),
    ).toBe(boom);
    expect(
      outcomeError({ status: 'cancelled', payload: { reason: 'client-abort' } }),
    ).toBeInstanceOf(RunCancelledError);
  });
});

describe('event plane run lifecycle', () => {
  test('endRun ends a run once and publishes its run-end event to every channel', async () => {
    const network = AgentNetwork.setup(({ createChannel }) => {
      createChannel('client');
    });

    const program = Effect.gen(function* () {
      const plane = yield* createEventPlane({ network });
      const main = yield* plane.subscribe(ChannelName('main'));
      const client = yield* plane.subscribe(ChannelName('client'));

      const first = yield* plane.endRun(meta, {
        status: 'cancelled',
        payload: { reason: 'stream-closed' },
      });
      const second = yield* plane.endRun(meta, {
        status: 'completed',
        payload: { reason: 'agent', agentId: 'a' },
      });

      return {
        first,
        second,
        outcome: plane.getRunOutcome(meta.runId),
        awaited: yield* plane.awaitRunEnd(meta.runId),
        received: [yield* Queue.take(main), yield* Queue.take(client)],
        pending: [yield* Queue.size(main), yield* Queue.size(client)],
      };
    });

    const result = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(result.first).toBe(true);
    expect(result.second).toBe(false);
    expect(result.outcome).toEqual({ status: 'cancelled', payload: { reason: 'stream-closed' } });
    expect(result.awaited).toBe(result.outcome);
    for (const envelope of result.received) {
      expect(envelope).toEqual({
        name: RunLifecycleEvent.cancelled,
        meta: { ...meta, eventId: expect.any(String), ts: expect.any(Number), depth: 0 },
        payload: { reason: 'stream-closed' },
      });
    }
    expect(result.pending).toEqual([0, 0]);
  });

  test('runtime lifecycle events never invoke agents, even listen-all ones', async () => {
    const logic = vitest.fn(async () => {});
    const network = AgentNetwork.setup(({ mainChannel, registerAgent }) => {
      // No listensTo: the agent listens to every event on main.
      registerAgent(AgentFactory.run().logic(logic).produce({})).subscribe(mainChannel);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      // The run is still active: only the reserved name keeps the agent out.
      yield* plane.publish(ChannelName('main'), {
        name: RunLifecycleEvent.agentError,
        meta,
        payload: { agentId: 'other', trigger: 'x', error: { name: 'Error', message: 'x' } },
      });
      yield* Effect.sleep('20 millis');
      return plane.getRunOutcome(meta.runId);
    });

    const outcome = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(outcome).toBeUndefined();
    expect(logic).not.toHaveBeenCalled();
  });

  test('events of an ended run start no new invocations', async () => {
    const logic = vitest.fn(async () => {});
    const anything = AgentNetworkEvent.of('anything', S.Struct({}));
    const network = AgentNetwork.setup(({ mainChannel, registerAgent }) => {
      registerAgent(AgentFactory.run().listensTo([anything]).logic(logic).produce({})).subscribe(
        mainChannel,
      );
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* plane.endRun(meta, { status: 'cancelled', payload: { reason: 'client-abort' } });
      yield* plane.publish(ChannelName('main'), anything.makeBound(meta, {}));
      yield* plane.publish(
        ChannelName('main'),
        anything.makeBound({ runId: 'run-2', contextId: 'ctx-1' }, {}),
      );
      yield* Effect.sleep('20 millis');
    });

    await Effect.runPromise(program.pipe(Effect.scoped));

    // Only the still-active run-2 reached the agent.
    expect(logic).toHaveBeenCalledTimes(1);
    expect(logic).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerEvent: expect.objectContaining({
          meta: expect.objectContaining({ runId: 'run-2', contextId: 'ctx-1' }),
        }),
      }),
    );
  });
});

describe('run lifecycle types', () => {
  test('setup options accept an agent error policy', () => {
    expectTypeOf<AgentNetworkSetupOptions['onAgentError']>().toEqualTypeOf<
      AgentErrorPolicy | undefined
    >();
    expectTypeOf<AgentErrorPolicy>().toEqualTypeOf<'fail' | 'continue'>();
  });

  test('endsOn takes an event definition and a typed predicate', () => {
    const answer = AgentNetworkEvent.of('answer', S.Struct({ final: S.Boolean }));
    AgentNetwork.setup(
      ({ endsOn }) => {
        endsOn(answer);
        endsOn(answer, (envelope) => {
          expectTypeOf(envelope.name).toEqualTypeOf<'answer'>();
          expectTypeOf(envelope.payload).toEqualTypeOf<typeof answer.payload.Type>();
          return envelope.payload.final;
        });
        // Type checks only: nothing emits the terminal event.
      },
      { wiring: { ignore: ['terminal-event-not-emitted'] } },
    );
    expectTypeOf<AgentNetworkSetupContext['endsOn']>().returns.toEqualTypeOf<void>();
  });

  test('SSE consumer options accept run limits', () => {
    expectTypeOf<{
      idleTimeout: '30 seconds';
      maxDuration: number;
    }>().toMatchTypeOf<SseProxyConsumerOptions>();
  });
});
