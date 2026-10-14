import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import type { Envelope } from '../agent-network/event-plane.js';
import { RunLifecycleEvent } from '../agent-network/run-lifecycle.js';
import { ChannelName } from '../identifiers/channel-name.js';
import { Tool } from '../tool.js';
import type { NetworkTracer, NetworkTraceStatus } from '../tracing/network-tracer.js';
import { noopRunTraceScope } from '../tracing/network-tracer.js';
import { registerSSEStream } from './proxy-consumer.js';
import type { ExposedStream } from './types.js';

const requestEvent = AgentNetworkEvent.of('request', S.Struct({ request: S.String }));
const answerEvent = AgentNetworkEvent.of('answer', S.Struct({ answer: S.String }));
const progressEvent = AgentNetworkEvent.of('progress', S.Struct({ step: S.Number }));

/** Store key of `contextId` for requests without a principal. */
const anonymousKey = (contextId: string) => ({ namespace: 'anonymous', contextId });

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

function post(payload: unknown, signal?: AbortSignal): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

function gateForTest(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Resolves once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

type TracerCall = {
  hook: string;
  name?: string;
  error?: Error;
  payload?: unknown;
  status?: NetworkTraceStatus;
};

function recordingTracer(options: { invokeEndDelayMs?: number } = {}): {
  tracer: NetworkTracer;
  calls: TracerCall[];
} {
  const calls: TracerCall[] = [];
  const tracer: NetworkTracer = {
    onRunStart: async () => {
      calls.push({ hook: 'onRunStart' });
    },
    onRunEnd: async (_meta, error, options) => {
      calls.push({ hook: 'onRunEnd', error, status: options?.status });
    },
    onEventPublish: async ({ name, payload }) => {
      calls.push({ hook: 'publish', name, payload });
    },
    onAgentInvokeStart: async ({ trigger }) => {
      calls.push({ hook: 'onAgentInvokeStart', name: trigger.name });
      return noopRunTraceScope(trigger.meta);
    },
    onAgentInvokeEnd: async (_scope, error, endOptions) => {
      if (options.invokeEndDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.invokeEndDelayMs));
      }
      calls.push({ hook: 'onAgentInvokeEnd', error, status: endOptions?.status });
    },
    flush: async () => {},
  };
  return { tracer, calls };
}

const requestAgent = AgentFactory.run()
  .listensTo([requestEvent])
  .emits([answerEvent, progressEvent]);
type RequestAgentLogic = Parameters<typeof requestAgent.logic>[0];

/** One agent on main -> client; `logic` decides what it does with the request. */
function singleAgentNetwork(
  logic: RequestAgentLogic,
  options: { endsOnAnswer?: boolean; setup?: AgentNetworkSetupOptions } = {},
) {
  return AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(requestAgent.logic(logic).produce({})).subscribe(mainChannel).publishTo(client);
    if (options.endsOnAnswer) endsOn(answerEvent);
  }, options.setup);
}

describe('expose run lifecycle', () => {
  describe('completion', () => {
    test('a declared terminal event completes the run and closes the stream', async () => {
      const network = singleAgentNetwork(
        async ({ emit }) => {
          emit(progressEvent.make({ step: 1 }));
          emit(answerEvent.make({ answer: '42' }));
        },
        { endsOnAnswer: true },
      );
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.map((e) => e.name)).toEqual([
        'progress',
        'answer',
        RunLifecycleEvent.completed,
      ]);
      expect(events[2]).toMatchObject({
        payload: { reason: 'terminal-event', event: 'answer' },
      });
    });

    test('endsOn `when` only ends the run for matching events', async () => {
      const message = AgentNetworkEvent.of('message', S.Struct({ role: S.String, text: S.String }));
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
          const client = createChannel('client').proxy(proxy.sse());
          registerAgent(
            AgentFactory.run()
              .listensTo([message])
              .emits([message])
              .logic(async ({ triggerEvent, emit }) => {
                emit(message.make({ role: 'assistant', text: `re: ${triggerEvent.payload.text}` }));
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(client);
          // The user's message is the same event and must not end the run.
          endsOn(message, (envelope) => {
            expectTypeOf(envelope.payload).toEqualTypeOf<typeof message.payload.Type>();
            return envelope.payload.role === 'assistant';
          });
        },
      );
      const api = network.expose(registerSSEStream({ triggerEvents: [message] }));

      const events = await api.createStream(
        { request: post({ role: 'user', text: 'hi' }) },
        collect,
      );

      expect(events.map((e) => e.name)).toEqual(['message', RunLifecycleEvent.completed]);
      expect(events[0]).toMatchObject({ payload: { role: 'assistant', text: 're: hi' } });
    });

    test('ctx.complete() ends the run after the agent’s earlier emits', async () => {
      let agentId: string | undefined;
      const network = AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent }) => {
        const client = createChannel('client').proxy(proxy.sse());
        const agent = AgentFactory.run()
          .listensTo([requestEvent])
          .emits([answerEvent])
          .logic(async ({ emit, complete }) => {
            emit(answerEvent.make({ answer: 'a' }));
            emit(answerEvent.make({ answer: 'b' }));
            complete();
          })
          .produce({});
        agentId = agent.getId();
        registerAgent(agent).subscribe(mainChannel).publishTo(client);
      });
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.map((e) => [e.name, e.payload])).toEqual([
        ['answer', { answer: 'a' }],
        ['answer', { answer: 'b' }],
        [RunLifecycleEvent.completed, { reason: 'agent', agentId }],
      ]);
    });

    test('a tool can complete the calling agent’s run', async () => {
      const finish = Tool.of({ name: 'finish', description: 'Ends the run' })
        .input(S.Struct({}))
        .output(S.Struct({ ok: S.Boolean }))
        .define(({ complete }) => {
          complete();
          return { ok: true };
        });
      const network = AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent }) => {
        const client = createChannel('client').proxy(proxy.sse());
        registerAgent(
          AgentFactory.run()
            .listensTo([requestEvent])
            .emits([answerEvent])
            .tools(finish)
            .logic(async ({ emit, tools }) => {
              emit(answerEvent.make({ answer: 'done' }));
              await tools.toTools()[0]?.execute({});
            })
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(client);
      });
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.map((e) => e.name)).toEqual(['answer', RunLifecycleEvent.completed]);
    });
  });

  describe('agent failures', () => {
    test("'fail' (default): run fails sanitized, other agents abort, tracer gets the error", async () => {
      const boom = new TypeError('upstream exploded');
      let siblingSignal: AbortSignal | undefined;
      const { tracer, calls } = recordingTracer();
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, proxy, registerAgent }) => {
          const client = createChannel('client').proxy(proxy.sse());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvent])
              .logic(async () => {
                throw boom;
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(client);
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvent])
              .logic(async ({ signal }) => {
                siblingSignal = signal;
                await aborted(signal);
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(client);
        },
        { networkTracer: tracer },
      );
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: RunLifecycleEvent.failed,
        payload: {
          error: { name: 'TypeError', message: 'upstream exploded', kind: 'agent-error' },
          agentId: expect.any(String),
        },
      });
      expect(JSON.stringify(events[0])).not.toContain('stack');
      expect(JSON.stringify(events[0])).not.toContain('at ');
      expect(siblingSignal?.aborted).toBe(true);
      expect(calls.find((c) => c.hook === 'onRunEnd')).toMatchObject({
        error: boom,
        status: 'error',
      });
      expect(calls.filter((c) => c.hook === 'onAgentInvokeEnd').map((c) => c.error)).toEqual(
        expect.arrayContaining([boom, expect.objectContaining({ name: 'AgentAbortedError' })]),
      );
    });

    test('ctx.fail() fails the run even under the continue policy', async () => {
      const network = singleAgentNetwork(
        async ({ fail }) => {
          fail(new Error('quota exceeded'));
        },
        { setup: { onAgentError: 'continue' } },
      );
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events).toEqual([
        expect.objectContaining({
          name: RunLifecycleEvent.failed,
          payload: expect.objectContaining({
            error: { name: 'Error', message: 'quota exceeded', kind: 'agent-error' },
          }),
        }),
      ]);
    });

    test("'continue': agent error is reported and the run goes on to complete", async () => {
      const { tracer, calls } = recordingTracer();
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
          const client = createChannel('client').proxy(proxy.sse());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvent])
              .logic(async () => {
                throw new Error('flaky');
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(client);
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvent])
              .emits([answerEvent])
              .logic(async ({ emit }) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                emit(answerEvent.make({ answer: 'still here' }));
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(client);
          endsOn(answerEvent);
        },
        { networkTracer: tracer, onAgentError: 'continue' },
      );
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.map((e) => e.name)).toEqual([
        RunLifecycleEvent.agentError,
        'answer',
        RunLifecycleEvent.completed,
      ]);
      expect(events[0]).toMatchObject({
        payload: { trigger: 'request', error: { name: 'Error', message: 'flaky' } },
      });
      expect(JSON.stringify(events[0])).not.toContain('stack');
      expect(calls.find((c) => c.hook === 'onRunEnd')).toMatchObject({
        error: undefined,
        status: 'ok',
      });
    });
  });

  describe('safety net', () => {
    test('idle timeout fails a run whose agents are done but which never ended', async () => {
      const network = singleAgentNetwork(async () => {});
      const api = network.expose(
        registerSSEStream({ triggerEvents: [requestEvent], idleTimeout: '40 millis' }),
      );

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events).toEqual([
        expect.objectContaining({
          name: RunLifecycleEvent.failed,
          payload: {
            error: expect.objectContaining({ name: 'RunTimeoutError', kind: 'idle-timeout' }),
          },
        }),
      ]);
    });

    test('idle time does not accrue while an agent invocation is in flight', async () => {
      // e.g. an agent waiting for an LLM call or a user approval without emitting anything.
      const network = singleAgentNetwork(
        async ({ emit }) => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          emit(answerEvent.make({ answer: 'slow but alive' }));
        },
        { endsOnAnswer: true },
      );
      const api = network.expose(
        registerSSEStream({ triggerEvents: [requestEvent], idleTimeout: '30 millis' }),
      );

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.map((e) => e.name)).toEqual(['answer', RunLifecycleEvent.completed]);
    });

    test('idle time counts from when the last invocation settled', async () => {
      const network = singleAgentNetwork(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      const api = network.expose(
        registerSSEStream({ triggerEvents: [requestEvent], idleTimeout: '30 millis' }),
      );

      const startedAt = Date.now();
      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(85);
      expect(events).toEqual([
        expect.objectContaining({
          name: RunLifecycleEvent.failed,
          payload: { error: expect.objectContaining({ kind: 'idle-timeout' }) },
        }),
      ]);
    });

    test('max duration still fails a run whose agent is stuck, and aborts it', async () => {
      let agentSignal: AbortSignal | undefined;
      const network = singleAgentNetwork(async ({ signal }) => {
        agentSignal = signal;
        await aborted(signal);
      });
      const api = network.expose(
        registerSSEStream({
          triggerEvents: [requestEvent],
          idleTimeout: '20 millis',
          maxDuration: '80 millis',
        }),
      );

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events).toEqual([
        expect.objectContaining({
          name: RunLifecycleEvent.failed,
          payload: { error: expect.objectContaining({ kind: 'max-duration' }) },
        }),
      ]);
      expect(agentSignal?.aborted).toBe(true);
    });

    test('events keep an active run alive past the idle timeout', async () => {
      const network = singleAgentNetwork(
        async ({ emit }) => {
          for (let step = 1; step <= 4; step++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            emit(progressEvent.make({ step }));
          }
          emit(answerEvent.make({ answer: 'ok' }));
        },
        { endsOnAnswer: true },
      );
      const api = network.expose(
        registerSSEStream({ triggerEvents: [requestEvent], idleTimeout: '50 millis' }),
      );

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.at(-1)?.name).toBe(RunLifecycleEvent.completed);
      expect(events.filter((e) => e.name === 'progress')).toHaveLength(4);
    });

    test('max duration fails a run that keeps emitting', async () => {
      const network = singleAgentNetwork(async ({ emit, signal }) => {
        let step = 0;
        while (!signal.aborted) {
          emit(progressEvent.make({ step: step++ }));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      const api = network.expose(
        registerSSEStream({
          triggerEvents: [requestEvent],
          idleTimeout: '1 second',
          maxDuration: '60 millis',
        }),
      );

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.at(-1)).toMatchObject({
        name: RunLifecycleEvent.failed,
        payload: { error: { kind: 'max-duration' } },
      });
      expect(events.filter((e) => e.name === 'progress').length).toBeGreaterThan(1);
    });

    test('Infinity disables both limits', async () => {
      const network = singleAgentNetwork(
        async ({ emit }) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          emit(answerEvent.make({ answer: 'late but fine' }));
        },
        { endsOnAnswer: true },
      );
      const api = network.expose(
        registerSSEStream({
          triggerEvents: [requestEvent],
          idleTimeout: Infinity,
          maxDuration: Infinity,
        }),
      );

      const events = await api.createStream({ request: post({ request: 'q' }) }, collect);

      expect(events.map((e) => e.name)).toEqual(['answer', RunLifecycleEvent.completed]);
    });
  });

  describe('cancellation', () => {
    test('client abort aborts agent and tool signals and traces m4trix:run.cancelled', async () => {
      // A slow tracer proves the run waits for aborted invocations to finish tracing.
      const { tracer, calls } = recordingTracer({ invokeEndDelayMs: 30 });
      const signals: { agent?: AbortSignal; tool?: AbortSignal } = {};
      const waitForAbort = Tool.of({ name: 'wait', description: 'Waits until aborted' })
        .input(S.Struct({}))
        .output(S.Struct({ aborted: S.Boolean }))
        .define(async ({ signal }) => {
          signals.tool = signal;
          await aborted(signal);
          return { aborted: true };
        });
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, proxy, registerAgent }) => {
          const client = createChannel('client').proxy(proxy.sse());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvent])
              .emits([progressEvent])
              .tools(waitForAbort)
              .logic(async ({ emit, signal, tools }) => {
                signals.agent = signal;
                emit(progressEvent.make({ step: 1 }));
                await tools.toTools()[0]?.execute({});
                // The run is over: this emit is dropped on purpose.
                emit(progressEvent.make({ step: 2 }));
              })
              .produce({}),
          )
            .subscribe(mainChannel)
            .publishTo(client);
        },
        { networkTracer: tracer },
      );
      const api = network.expose(
        registerSSEStream({ reconnectWindow: 0, triggerEvents: [requestEvent] }),
      );
      const controller = new AbortController();
      const runId = 'cancelled-run';

      const events = await api.createStream(
        { request: post({ request: 'q' }, controller.signal), runId, contextId: 'ctx' },
        async (stream) => {
          const seen: Envelope[] = [];
          for await (const envelope of stream) {
            seen.push(envelope);
            controller.abort();
          }
          return seen;
        },
      );

      expect(events.map((e) => e.name)).toEqual(['progress']);
      expect(signals.agent?.aborted).toBe(true);
      expect(signals.tool?.aborted).toBe(true);
      expect(calls).toContainEqual({
        hook: 'publish',
        name: RunLifecycleEvent.cancelled,
        payload: { reason: 'client-abort' },
      });
      // Cancelled is its own status, not an error; the error stays for older tracers.
      expect(calls.find((c) => c.hook === 'onRunEnd')).toMatchObject({
        status: 'cancelled',
        error: expect.objectContaining({ name: 'RunCancelledError' }),
      });
      expect(calls.find((c) => c.hook === 'onAgentInvokeEnd')).toMatchObject({
        status: 'cancelled',
        error: expect.objectContaining({ name: 'AgentAbortedError' }),
      });
      // Aborted invocations finish tracing before the run ends.
      expect(
        calls.filter((c) => ['onAgentInvokeEnd', 'onRunEnd'].includes(c.hook)).map((c) => c.hook),
      ).toEqual(['onAgentInvokeEnd', 'onRunEnd']);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stored = await network.getStore().readRun(anonymousKey('ctx'), runId);
      expect(stored.map((e) => [e.name, e.payload])).toEqual([
        ['request', { request: 'q' }],
        ['progress', { step: 1 }],
        [RunLifecycleEvent.cancelled, { reason: 'client-abort' }],
      ]);
    });

    test('a consumer that stops reading cancels the run as stream-closed', async () => {
      let agentSignal: AbortSignal | undefined;
      const network = singleAgentNetwork(async ({ emit, signal }) => {
        agentSignal = signal;
        emit(progressEvent.make({ step: 1 }));
        await aborted(signal);
      });
      const api = network.expose(
        registerSSEStream({ reconnectWindow: 0, triggerEvents: [requestEvent] }),
      );
      const runId = 'closed-run';

      await api.createStream(
        { request: post({ request: 'q' }), runId, contextId: 'ctx' },
        async (stream) => {
          for await (const envelope of stream) return envelope;
          return undefined;
        },
      );

      expect(agentSignal?.aborted).toBe(true);
      expect((await network.getStore().readRun(anonymousKey('ctx'), runId)).at(-1)).toMatchObject({
        name: RunLifecycleEvent.cancelled,
        payload: { reason: 'stream-closed' },
      });
    });
  });

  test('a failing onRequest cancels the run it already started', async () => {
    let agentSignal: AbortSignal | undefined;
    const network = singleAgentNetwork(async ({ signal }) => {
      agentSignal = signal;
      await aborted(signal);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      const api = network.expose(
        registerSSEStream({
          reconnectWindow: 0,
          plane,
          onRequest: async ({ emitStartEvent, payload }) => {
            emitStartEvent({
              runId: 'half-started',
              contextId: 'ctx',
              event: requestEvent.make(payload),
            });
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('lookup failed');
          },
        }),
      );
      return yield* Effect.either(
        Effect.tryPromise(() => api.createStream({ request: post({ request: 'q' }) }, collect)),
      );
    });

    const result = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(result._tag).toBe('Left');
    expect(agentSignal?.aborted).toBe(true);
    expect(
      (await network.getStore().readRun(anonymousKey('ctx'), 'half-started')).at(-1),
    ).toMatchObject({
      name: RunLifecycleEvent.cancelled,
      payload: { reason: 'stream-closed' },
    });
  });

  describe('readiness', () => {
    test('the start event reaches agents for many concurrent streams', async () => {
      const network = singleAgentNetwork(
        async ({ triggerEvent, emit }) => {
          emit(answerEvent.make({ answer: triggerEvent.payload.request }));
        },
        { endsOnAnswer: true },
      );
      const api = network.expose(registerSSEStream({ triggerEvents: [requestEvent] }));

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          api.createStream({ request: post({ request: `q${i}` }) }, collect),
        ),
      );

      results.forEach((events, i) => {
        expect(events.map((e) => [e.name, e.payload])).toEqual([
          ['answer', { answer: `q${i}` }],
          [RunLifecycleEvent.completed, { reason: 'terminal-event', event: 'answer' }],
        ]);
      });
    });

    test('network.run() returns once agents are subscribed', async () => {
      const network = singleAgentNetwork(async ({ emit }) => {
        emit(answerEvent.make({ answer: 'ready' }));
      });

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(registerSSEStream({ plane }));
        const main = ChannelName('main');
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: post({}) }, async (stream) => {
            // Published without any delay after run(): the agent must still see it.
            await Effect.runPromise(
              plane.publish(
                main,
                requestEvent.makeBound({ runId: 'r', contextId: 'c' }, { request: 'x' }),
              ),
            );
            for await (const envelope of stream) return envelope;
            return undefined;
          }),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(received).toMatchObject({ name: 'answer', payload: { answer: 'ready' } });
    });

    test('a stream that is not being read holds back only its own run on a shared plane', async () => {
      const network = singleAgentNetwork(
        async ({ triggerEvent, emit }) => {
          // The stalled run floods its stream well past the subscriber queue's capacity.
          const steps = triggerEvent.payload.request === 'stalled' ? 40 : 1;
          for (let step = 0; step < steps; step++) emit(progressEvent.make({ step }));
          emit(answerEvent.make({ answer: triggerEvent.payload.request }));
        },
        { endsOnAnswer: true },
      );
      const stalledReader = gateForTest();

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(
          registerSSEStream({
            plane,
            onRequest: ({ emitStartEvent, req, payload }) =>
              emitStartEvent({
                runId: req.runId ?? crypto.randomUUID(),
                contextId: 'shared',
                event: requestEvent.make(payload),
              }),
          }),
        );
        const stalled = api.createStream(
          { request: post({ request: 'stalled' }), runId: 'run-stalled' },
          async (stream) => {
            await stalledReader.wait;
            return collect(stream);
          },
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
        const fast = yield* Effect.tryPromise(() =>
          api.createStream({ request: post({ request: 'fast' }), runId: 'run-fast' }, collect),
        ).pipe(Effect.timeoutFail({ duration: '500 millis', onTimeout: () => 'fast run blocked' }));
        stalledReader.open();
        return { fast, stalled: yield* Effect.promise(() => stalled) };
      });

      const { fast, stalled } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(fast.map((e) => e.name)).toEqual(['progress', 'answer', RunLifecycleEvent.completed]);
      expect(stalled.at(-1)?.name).toBe(RunLifecycleEvent.completed);
      expect(stalled.filter((e) => e.name === 'progress')).toHaveLength(40);
    });

    test('streams on a shared plane only see, and end with, their own run', async () => {
      const network = singleAgentNetwork(
        async ({ triggerEvent, emit }) => {
          await new Promise((resolve) =>
            setTimeout(resolve, triggerEvent.payload.request === 'slow' ? 30 : 0),
          );
          emit(answerEvent.make({ answer: triggerEvent.payload.request }));
        },
        { endsOnAnswer: true },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(
          registerSSEStream({
            plane,
            onRequest: ({ emitStartEvent, req, payload }) =>
              emitStartEvent({
                runId: req.runId ?? crypto.randomUUID(),
                contextId: 'shared',
                event: requestEvent.make(payload),
              }),
          }),
        );
        return yield* Effect.tryPromise(() =>
          Promise.all(
            ['slow', 'fast'].map((request) =>
              api.createStream({ request: post({ request }), runId: `run-${request}` }, collect),
            ),
          ),
        );
      });

      const [slow, fast] = await Effect.runPromise(program.pipe(Effect.scoped));
      for (const [events, request] of [
        [slow, 'slow'],
        [fast, 'fast'],
      ] as const) {
        expect(events.map((e) => [e.name, e.meta.runId])).toEqual([
          ['answer', `run-${request}`],
          [RunLifecycleEvent.completed, `run-${request}`],
        ]);
      }
    });
  });
});
