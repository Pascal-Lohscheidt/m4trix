import { Chunk, Effect, Queue, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { ChannelName } from '../identifiers/channel-name.js';
import { Tool } from '../tool.js';
import { EmitValidationError, type ValidationIssue } from '../validation.js';
import { AgentNetwork, type AgentNetworkSetupOptions, type AnyAgent } from './agent-network.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import { EventAggregator } from './event-aggregator.js';
import type { Envelope } from './event-plane.js';
import {
  type RunErrorKind,
  type RunFailedPayload,
  RunLifecycleEvent,
  type RunOutcome,
} from './run-lifecycle.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
const note = AgentNetworkEvent.of('note', S.Struct({ from: S.String }));
const count = AgentNetworkEvent.of('count', S.Struct({ n: S.NumberFromString }));

const main = ChannelName('main');
const meta = { runId: 'run-1', contextId: 'ctx-1' };

/** Lets a test emit what the agent's types would not allow, as model output would. */
const untyped = <T>(event: { name: string; payload: unknown }): T => event as T;

/** The tests read main with `plane.subscribe` (`runOnce`): no agent consumes the emits. */
const mainReaders: AgentNetworkSetupOptions = { wiring: { ignore: ['unconsumed-event'] } };

/** One agent on main (listening to `start`), publishing to main. */
function networkWith(agent: AnyAgent, options?: AgentNetworkSetupOptions) {
  return AgentNetwork.setup(
    ({ mainChannel, registerAgent }) => {
      registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
    },
    { ...mainReaders, ...options },
  );
}

/** Publishes `start` and collects what main saw until the run ended (or `waitFor` was seen). */
async function runOnce(
  network: AgentNetwork,
  options: { waitFor?: string } = {},
): Promise<{ events: Envelope[]; outcome: RunOutcome | undefined }> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const plane = yield* network.run();
      const seen = yield* plane.subscribe(main);
      yield* plane.publish(main, start.makeBound(meta, {}));
      const events: Envelope[] = [];
      while (true) {
        const next = yield* Queue.take(seen);
        events.push(next);
        if (next.name === options.waitFor) break;
        if (next.name.startsWith('m4trix:run.')) break;
      }
      yield* Effect.sleep('10 millis');
      events.push(...Chunk.toReadonlyArray(yield* Queue.takeAll(seen)));
      return { events, outcome: plane.getRunOutcome(meta.runId) };
    }).pipe(Effect.scoped),
  );
}

const failedPayload = (events: readonly Envelope[]): RunFailedPayload => {
  const failed = events.find((e) => e.name === RunLifecycleEvent.failed);
  if (!failed) throw new Error(`run did not fail: ${events.map((e) => e.name).join(', ')}`);
  return failed.payload as RunFailedPayload;
};

describe('strict emit validation', () => {
  test('an undeclared emit throws EmitValidationError, is not published and fails the run (invalid-emit)', async () => {
    let caught: unknown;
    let agentId = '';
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer])
      .logic(async ({ emit }) => {
        try {
          emit(untyped(note.make({ from: 'agent' })));
        } catch (error) {
          caught = error;
        }
      })
      .produce({});
    agentId = agent.getId();

    const { events } = await runOnce(networkWith(agent));

    expect(caught).toBeInstanceOf(EmitValidationError);
    expect(caught).toMatchObject({
      _tag: 'EmitValidationError',
      eventName: 'note',
      agentId,
      toolName: undefined,
      reason: 'undeclared',
      issues: [],
    });
    expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
    // Caught by the agent or not, an invalid emit fails the invocation.
    expect(failedPayload(events)).toEqual({
      agentId,
      error: {
        name: 'EmitValidationError',
        message: expect.stringContaining('"note"'),
        kind: 'invalid-emit',
        event: 'note',
      },
    });
  });

  test('a payload that fails the event schema throws, is not published, and the failure stays sanitized', async () => {
    let caught: unknown;
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer])
      .logic(async ({ emit }) => {
        try {
          emit(untyped({ name: 'answer', payload: { text: { apiKey: 'sk-secret-123' } } }));
        } catch (error) {
          caught = error;
          throw error;
        }
      })
      .produce({});

    const { events } = await runOnce(networkWith(agent));

    expect(caught).toBeInstanceOf(EmitValidationError);
    const error = caught as EmitValidationError;
    expect(error.reason).toBe('invalid-payload');
    expect(error.issues).toEqual([{ path: 'text', message: expect.any(String) }]);
    expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
    const payload = failedPayload(events);
    expect(payload.error).toMatchObject({ kind: 'invalid-emit', event: 'answer' });
    expect(payload.error.message).toMatch(/text/);
    // Neither the message nor anything else on the client-facing payload quotes the value.
    expect(JSON.stringify(payload)).not.toContain('sk-secret-123');
    expect(error.message).not.toContain('sk-secret-123');
  });

  test("under onAgentError 'continue' an invalid emit publishes m4trix:agent.error and the run goes on", async () => {
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer])
      .logic(async ({ emit }) => {
        emit(untyped(note.make({ from: 'agent' })));
      })
      .produce({});

    const { events, outcome } = await runOnce(networkWith(agent, { onAgentError: 'continue' }), {
      waitFor: RunLifecycleEvent.agentError,
    });

    expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.agentError]);
    expect(events[1]?.payload).toEqual({
      agentId: agent.getId(),
      trigger: 'start',
      error: { name: 'EmitValidationError', message: expect.stringContaining('"note"') },
    });
    expect(outcome).toBeUndefined();
  });

  test('the decoded payload is published (schema transformations applied)', async () => {
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([count, answer])
      .logic(async ({ emit }) => {
        // Raw (encoded) model output is decoded ...
        emit(untyped({ name: 'count', payload: { n: '42' } }));
        // ... and a value that already is of the event's type (from make()) is accepted as is.
        emit(count.make({ n: '7' }));
        emit(answer.make({ text: 'done' }));
      })
      .produce({});
    const network = AgentNetwork.setup(({ mainChannel, registerAgent, endsOn }) => {
      registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
      endsOn(answer);
    }, mainReaders);

    const { events } = await runOnce(network);

    expect(events.filter((e) => e.name === 'count').map((e) => e.payload)).toEqual([
      { n: 42 },
      { n: 7 },
    ]);
  });

  test('a payload that already is exactly of the event type is published as is (same object)', async () => {
    const made = answer.make({ text: 'done' });
    const extra = { name: 'note', payload: { from: 'agent', debug: 'stripped' } };
    let published: Envelope[] = [];
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer, note])
      .logic(async ({ emit }) => {
        emit(untyped(extra));
        emit(made);
      })
      .produce({});
    const network = AgentNetwork.setup(({ mainChannel, registerAgent, endsOn }) => {
      registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
      endsOn(answer);
    }, mainReaders);

    published = (await runOnce(network)).events;

    expect(published.find((e) => e.name === 'answer')?.payload).toBe(made.payload);
    // Excess properties are not part of the event: the payload is decoded, which drops them.
    expect(published.find((e) => e.name === 'note')?.payload).toEqual({ from: 'agent' });
  });

  test('emitAndAwait rejects with EmitValidationError and publishes nothing', async () => {
    let caught: unknown;
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer])
      .logic(async ({ emitAndAwait }) => {
        caught = await emitAndAwait(untyped(note.make({ from: 'agent' })), () => true).catch(
          (error: unknown) => error,
        );
      })
      .produce({});

    const { events } = await runOnce(networkWith(agent));

    expect(caught).toBeInstanceOf(EmitValidationError);
    expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
    expect(failedPayload(events).error.kind).toBe('invalid-emit');
  });

  test('an agent without emits() may emit nothing', async () => {
    const agent = AgentFactory.run()
      .listensTo([start])
      .logic(async ({ emit }) => {
        emit(untyped(answer.make({ text: 'hi' })));
      })
      .produce({});

    const { events } = await runOnce(networkWith(agent));

    expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
    expect(failedPayload(events).error).toMatchObject({ kind: 'invalid-emit', event: 'answer' });
  });

  test('reserved m4trix:* names cannot be emitted', async () => {
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer])
      .logic(async ({ emit }) => {
        emit(untyped({ name: RunLifecycleEvent.completed, payload: { reason: 'agent' } }));
      })
      .produce({});

    const { events } = await runOnce(networkWith(agent));

    expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
    expect(failedPayload(events).error.kind).toBe('invalid-emit');
  });

  describe('tools', () => {
    test('a tool emitting an event it does not declare fails the run, even when the agent swallows tool errors', async () => {
      const leaky = Tool.of({ name: 'leaky', description: 'Emits what it should not' })
        .input(S.Struct({}))
        .output(S.Struct({}))
        .emits([note])
        .define(({ emit }) => {
          emit(untyped(answer.make({ text: 'not mine' })));
          return {};
        });
      let caught: unknown;
      const agent = AgentFactory.run()
        .listensTo([start])
        .emits([answer])
        .tools(leaky)
        .logic(async ({ tools }) => {
          caught = await tools
            .toTools()[0]
            ?.executeForModel({})
            .catch((error: unknown) => error);
        })
        .produce({});

      const { events } = await runOnce(networkWith(agent));

      expect(caught).toBeInstanceOf(EmitValidationError);
      expect(caught).toMatchObject({
        eventName: 'answer',
        toolName: 'leaky',
        agentId: agent.getId(),
        reason: 'undeclared',
      });
      expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
      expect(failedPayload(events)).toMatchObject({
        agentId: agent.getId(),
        error: { kind: 'invalid-emit', event: 'answer' },
      });
    });

    test('a tool payload that fails the schema throws (not retried, not a tool error)', async () => {
      let attempts = 0;
      const bad = Tool.of({ name: 'bad', description: 'Bad payload' })
        .input(S.Struct({}))
        .output(S.Struct({}))
        .emits([note])
        .retry({ times: 2 })
        .define(({ emit }) => {
          attempts++;
          emit(untyped({ name: 'note', payload: { from: 1 } }));
          return {};
        });
      let caught: unknown;
      const agent = AgentFactory.run()
        .listensTo([start])
        .tools(bad)
        .logic(async ({ tools }) => {
          caught = await tools
            .toTools()[0]
            ?.execute({})
            .catch((error: unknown) => error);
        })
        .produce({});

      const { events } = await runOnce(networkWith(agent));

      expect(attempts).toBe(1);
      expect(caught).toBeInstanceOf(EmitValidationError);
      expect(caught).toMatchObject({ reason: 'invalid-payload', toolName: 'bad' });
      expect((caught as EmitValidationError).issues).toEqual([
        { path: 'from', message: expect.any(String) },
      ]);
      expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
    });

    test("a tool's declared emits are published even when the agent does not declare them", async () => {
      const noter = Tool.of({ name: 'noter', description: 'Leaves a note' })
        .input(S.Struct({}))
        .output(S.Struct({}))
        .emits([note])
        .define(({ emit }) => {
          emit(note.make({ from: 'tool' }));
          return {};
        });
      const agent = AgentFactory.run()
        .listensTo([start])
        .emits([answer])
        .tools(noter)
        .logic(async ({ tools, emit }) => {
          await tools.toTools()[0]?.execute({});
          emit(answer.make({ text: 'ok' }));
        })
        .produce({});
      const network = AgentNetwork.setup(({ mainChannel, registerAgent, endsOn }) => {
        registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
        endsOn(answer);
      }, mainReaders);

      const { events } = await runOnce(network);

      expect(events.map((e) => e.name)).toEqual([
        'start',
        'note',
        'answer',
        RunLifecycleEvent.completed,
      ]);
    });

    test('bound outside an agent, a tool still validates its emits', async () => {
      const received: unknown[] = [];
      const counter = Tool.of({ name: 'counter', description: 'Counts' })
        .input(S.Struct({}))
        .output(S.Struct({}))
        .emits([count])
        .define(({ emit }) => {
          emit(untyped({ name: 'count', payload: { n: '5' } }));
          emit(untyped(note.make({ from: 'x' })));
          return {};
        });

      const error = await counter
        .bind({ layers: {}, emit: (event) => received.push(event) })
        .execute({})
        .catch((e: unknown) => e);

      expect(received).toEqual([{ name: 'count', payload: { n: 5 } }]);
      expect(error).toBeInstanceOf(EmitValidationError);
      expect(error).toMatchObject({ toolName: 'counter', agentId: undefined, eventName: 'note' });
    });
  });

  test('event aggregators validate their emits too', async () => {
    const aggregator = EventAggregator.listensTo([start])
      .emits([answer])
      .mapToEmit(({ emit }) => {
        emit(untyped(note.make({ from: 'aggregator' })));
      });
    const network = AgentNetwork.setup(({ mainChannel, registerAggregator }) => {
      registerAggregator(aggregator).subscribe(mainChannel).publishTo(mainChannel);
    }, mainReaders);

    const { events } = await runOnce(network);

    expect(events.map((e) => e.name)).toEqual(['start', RunLifecycleEvent.failed]);
    expect(failedPayload(events)).toMatchObject({
      agentId: aggregator.getId(),
      error: { kind: 'invalid-emit', event: 'note' },
    });
  });

  test('a standalone invocation hands decoded events to emit and rejects invalid ones', async () => {
    const emitted: unknown[] = [];
    const agent = AgentFactory.run()
      .emits([count])
      .logic(async ({ emit }) => {
        emit(untyped({ name: 'count', payload: { n: '3' } }));
        emit(untyped({ name: 'count', payload: { n: 'three' } }));
      })
      .produce({});

    const error = await agent.invoke({ emit: (event) => emitted.push(event) }).catch((e) => e);

    expect(emitted).toEqual([{ name: 'count', payload: { n: 3 } }]);
    expect(error).toBeInstanceOf(EmitValidationError);
    expect(error).toMatchObject({ reason: 'invalid-payload', eventName: 'count' });
  });

  test('types', () => {
    expectTypeOf<EmitValidationError['_tag']>().toEqualTypeOf<'EmitValidationError'>();
    expectTypeOf<EmitValidationError['eventName']>().toEqualTypeOf<string>();
    expectTypeOf<EmitValidationError['agentId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EmitValidationError['toolName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EmitValidationError['reason']>().toEqualTypeOf<
      'undeclared' | 'invalid-payload' | 'channel'
    >();
    expectTypeOf<EmitValidationError['issues']>().toEqualTypeOf<ReadonlyArray<ValidationIssue>>();
    expectTypeOf<'invalid-emit'>().toMatchTypeOf<RunErrorKind>();
  });
});
