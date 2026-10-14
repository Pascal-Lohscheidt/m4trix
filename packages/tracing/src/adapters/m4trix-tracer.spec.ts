import { AIMessage } from '@langchain/core/messages';
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  registerSSEStream,
} from '@m4trix/core/matrix';
import { Effect, Schema as S } from 'effect';
import { describe, expect, it } from 'vitest';
import { type TraceEvent, Tracer, type TracerOptions } from '../index.js';
import { recordingTraceStore } from '../testing/recording-stores.js';
import { toM4trixTracer } from './m4trix-tracer.js';

const trigger = (runId: string) => ({
  name: 'message',
  meta: { runId, contextId: 'ctx-1' },
  payload: { message: 'hello' },
});

function setup(options: TracerOptions = {}) {
  const store = recordingTraceStore();
  const tracer = Tracer.from(store.traceStore, { onError: () => {}, ...options });
  return { ...store, tracer };
}

describe('toM4trixTracer', () => {
  it('turns a network run into a trace with the context as its session', async () => {
    const { tracer, structure } = setup();
    const network = toM4trixTracer(tracer, { name: 'support-bot', projectId: 'support' });

    await network.onRunStart({ runId: 'run-1', contextId: 'ctx-1' });
    await network.onRunEnd({ runId: 'run-1', contextId: 'ctx-1' });

    expect(structure.trace('run-1')).toMatchObject({
      name: 'support-bot',
      sessionId: 'ctx-1',
      projectId: 'support',
      status: 'success',
    });
  });

  it('nests agent invocations and their spans, reading usage from LLM span output', async () => {
    const { tracer, structure, payloads } = setup();
    const network = toM4trixTracer(tracer);

    await network.onRunStart({ runId: 'run-1', contextId: 'ctx-1' });
    const scope = await network.onAgentInvokeStart({
      agentId: 'planner',
      channel: 'main',
      trigger: trigger('run-1'),
    });
    const llm = scope.startRun('llm', 'gpt-4o', { message: 'hello' });
    await llm.end(
      new AIMessage({
        content: 'hi',
        usage_metadata: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        response_metadata: { model_name: 'gpt-4o-2024-08-06' },
      }),
    );
    const search = scope.startRun('tool', 'search', 'query');
    await search.end(undefined, new Error('search down'));
    await network.onAgentInvokeEnd(scope);
    await network.onRunEnd({ runId: 'run-1', contextId: 'ctx-1' });

    expect(scope).toMatchObject({ contextId: 'ctx-1' });
    expect(structure.run(scope.runId)).toMatchObject({
      type: 'agent',
      name: 'planner',
      parentRunId: 'run-1',
      metadata: { agentId: 'planner', channel: 'main', event: 'message' },
      status: 'success',
    });
    expect(payloads.payloads.get(structure.run(scope.runId)?.inputRef ?? '')).toEqual({
      event: 'message',
      payload: { message: 'hello' },
    });
    expect(structure.run(llm.runId)).toMatchObject({
      type: 'llm',
      parentRunId: scope.runId,
      model: 'gpt-4o-2024-08-06',
      tokens: { input: 12, output: 3 },
    });
    expect(structure.run(search.runId)).toMatchObject({
      status: 'error',
      error: { message: 'search down' },
    });
    expect(structure.trace('run-1')).toMatchObject({
      runCount: 4,
      status: 'error',
      tokens: { input: 12, output: 3 },
    });
  });

  it('records reported usage as an llm run under the reporting invocation', async () => {
    const { tracer, structure } = setup();
    const network = toM4trixTracer(tracer);
    const runUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      byModel: {},
    };

    await network.onRunStart({ runId: 'run-1', contextId: 'ctx-1' });
    const scope = await network.onAgentInvokeStart({
      agentId: 'planner',
      trigger: trigger('run-1'),
    });
    await network.onUsage?.({
      runId: 'run-1',
      contextId: 'ctx-1',
      agentId: 'planner',
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        costUsd: 0.25,
        model: 'gpt-x',
      },
      runUsage,
      scope,
    });
    // Without a scope (e.g. the tracer never saw the invocation) it lands on the network run.
    await network.onUsage?.({
      runId: 'run-1',
      contextId: 'ctx-1',
      agentId: 'planner',
      tool: { name: 'embed', toolCallId: 'call-1' },
      usage: { inputTokens: 3 },
      runUsage,
    });
    await network.onAgentInvokeEnd(scope);
    await network.onRunEnd({ runId: 'run-1', contextId: 'ctx-1' });

    const record = await structure.getTrace(structure.trace('run-1')?.traceId ?? '');
    const usageRuns = record?.runs.filter((run) => run.type === 'llm') ?? [];
    expect(usageRuns).toEqual([
      expect.objectContaining({
        parentRunId: scope.runId,
        name: 'gpt-x',
        model: 'gpt-x',
        status: 'success',
        tokens: { input: 20, output: 5, cached: 4, cacheCreation: 2 },
        costUsd: 0.25,
        metadata: { source: 'reportUsage', agentId: 'planner' },
      }),
      expect.objectContaining({
        parentRunId: 'run-1',
        name: 'embed',
        tokens: { input: 3, output: 0 },
        metadata: {
          source: 'reportUsage',
          agentId: 'planner',
          tool: 'embed',
          toolCallId: 'call-1',
        },
      }),
    ]);
    expect(structure.trace('run-1')).toMatchObject({
      tokens: { input: 23, output: 5, cached: 4, cacheCreation: 2 },
      costUsd: 0.25,
    });
  });

  it('records published events on the network run, unless turned off', async () => {
    for (const captureEvents of [true, false]) {
      const { tracer, structure, payloads } = setup();
      const network = toM4trixTracer(tracer, { captureEvents });

      await network.onRunStart({ runId: 'run-1', contextId: 'ctx-1' });
      await network.onEventPublish({
        channel: 'main',
        name: 'message',
        meta: { runId: 'run-1', contextId: 'ctx-1' },
        payload: { message: 'hello' },
      });
      await network.onRunEnd({ runId: 'run-1', contextId: 'ctx-1' });

      const eventsRef = structure.run('run-1')?.eventsRef;
      if (captureEvents) {
        expect(payloads.payloads.get(eventsRef ?? '')).toEqual([
          {
            name: 'message',
            time: expect.any(String),
            data: { channel: 'main', payload: { message: 'hello' } },
          },
        ]);
      } else {
        expect(eventsRef).toBeUndefined();
      }
    }
  });

  it('ends failed agent invocations and runs as errors', async () => {
    const { tracer, structure } = setup();
    const network = toM4trixTracer(tracer);

    await network.onRunStart({ runId: 'run-1', contextId: 'ctx-1' });
    const scope = await network.onAgentInvokeStart({
      agentId: 'planner',
      trigger: trigger('run-1'),
    });
    await network.onAgentInvokeEnd(scope, new Error('agent crashed'));
    await network.onRunEnd({ runId: 'run-1', contextId: 'ctx-1' }, new Error('run failed'));

    expect(structure.run(scope.runId)).toMatchObject({
      status: 'error',
      error: { message: 'agent crashed' },
    });
    expect(structure.run('run-1')).toMatchObject({
      status: 'error',
      error: { message: 'run failed' },
    });
  });

  it('records cancelled runs and invocations as cancelled, not as errors', async () => {
    const { tracer, structure } = setup();
    const network = toM4trixTracer(tracer);

    await network.onRunStart({ runId: 'run-1', contextId: 'ctx-1' });
    const scope = await network.onAgentInvokeStart({
      agentId: 'planner',
      trigger: trigger('run-1'),
    });
    // Core still passes an error for tracers that predate the status; the status wins.
    await network.onAgentInvokeEnd(scope, new Error('Agent invocation aborted'), {
      status: 'cancelled',
    });
    await network.onRunEnd({ runId: 'run-1', contextId: 'ctx-1' }, new Error('Run cancelled'), {
      status: 'cancelled',
    });

    expect(structure.run(scope.runId)).toMatchObject({ status: 'cancelled' });
    expect(structure.run(scope.runId)?.error).toBeUndefined();
    expect(structure.run('run-1')).toMatchObject({ status: 'cancelled' });
    expect(structure.run('run-1')?.error).toBeUndefined();
    expect(structure.trace('run-1')).toMatchObject({ status: 'cancelled' });
  });

  it('still records errors passed with an explicit error status', async () => {
    const { tracer, structure } = setup();
    const network = toM4trixTracer(tracer);

    await network.onRunStart({ runId: 'run-1', contextId: 'ctx-1' });
    await network.onRunEnd({ runId: 'run-1', contextId: 'ctx-1' }, new Error('boom'), {
      status: 'error',
    });

    expect(structure.trace('run-1')).toMatchObject({ status: 'error' });
  });
});

describe('toM4trixTracer in an agent network', () => {
  const request = AgentNetworkEvent.of('request', S.Struct({ request: S.String }));
  const response = AgentNetworkEvent.of('response', S.Struct({ response: S.String }));

  function network(tracer: Tracer) {
    return AgentNetwork.setup(
      ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
        const client = createChannel('client').proxy(proxy.sse());
        endsOn(response);
        registerAgent(
          AgentFactory.run()
            .listensTo([request])
            .emits([response])
            .logic(async ({ triggerEvent, emit, tracing }) => {
              const llm = tracing.startRun('llm', 'answer', triggerEvent.payload);
              await llm.end(
                new AIMessage({
                  content: 'pong',
                  usage_metadata: { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
                }),
              );
              emit({ name: 'response', payload: { response: 'pong' } });
            })
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(client);
      },
      { networkTracer: toM4trixTracer(tracer) },
    );
  }

  async function ask(tracer: Tracer): Promise<unknown> {
    const agents = network(tracer);
    const program = Effect.gen(function* () {
      const plane = yield* agents.run();
      yield* Effect.sleep('10 millis');
      const api = agents.expose(
        registerSSEStream({
          plane,
          channel: 'client',
          triggerEvents: [request],
          onRequest: ({ emitStartEvent, payload }) =>
            emitStartEvent({
              contextId: 'conversation-1',
              runId: crypto.randomUUID(),
              event: request.make(payload as { request: string }),
            }),
        }),
      );
      const httpRequest = new Request('http://test/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'ping' }),
      });
      return yield* Effect.tryPromise(() =>
        api.createStream({ request: httpRequest }, async (stream) => {
          // Read until the run ends; stopping early would cancel the run.
          const events = [];
          for await (const event of stream) events.push(event);
          return events[0];
        }),
      );
    });
    return Effect.runPromise(program.pipe(Effect.scoped));
  }

  it('records the whole request as one trace: run, agent, LLM span, and events', async () => {
    const { tracer, structure, payloads } = setup();

    const received = await ask(tracer);
    await expectEventually(() => expect(structure.traces.at(-1)?.status).toBe('success'));

    expect(received).toMatchObject({ name: 'response', payload: { response: 'pong' } });
    expect(structure.traces.map((trace) => trace.traceId)).toSatisfy(
      (ids: string[]) => new Set(ids).size === 1,
    );
    const trace = structure.traces.at(-1);
    expect(trace).toMatchObject({
      name: 'agent-network',
      sessionId: 'conversation-1',
      runCount: 3,
      tokens: { input: 7, output: 1 },
    });
    const record = await structure.getTrace(trace?.traceId ?? '');
    const agent = record?.runs.find((run) => run.type === 'agent');
    expect(agent).toMatchObject({ parentRunId: trace?.rootRunId, name: expect.any(String) });
    expect(record?.runs.find((run) => run.type === 'llm')).toMatchObject({
      parentRunId: agent?.runId,
    });

    const events = payloads.payloads.get(
      structure.run(trace?.rootRunId ?? '')?.eventsRef ?? '',
    ) as TraceEvent[];
    expect(events.map((event) => event.name)).toEqual(
      expect.arrayContaining(['request', 'response']),
    );
  });

  it('records a request whose client stopped reading as a cancelled trace', async () => {
    const { tracer, structure } = setup();
    const progress = AgentNetworkEvent.of('progress', S.Struct({ step: S.Number }));
    const agents = AgentNetwork.setup(
      ({ mainChannel, createChannel, proxy, registerAgent }) => {
        const client = createChannel('client').proxy(proxy.sse());
        registerAgent(
          AgentFactory.run()
            .listensTo([request])
            .emits([progress])
            .logic(async ({ emit, signal }) => {
              emit(progress.make({ step: 1 }));
              await new Promise((resolve) => signal.addEventListener('abort', resolve));
            })
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(client);
      },
      { networkTracer: toM4trixTracer(tracer) },
    );
    // Without a reconnect window, the run is cancelled as soon as its stream is dropped.
    const api = agents.expose(registerSSEStream({ triggerEvents: [request], reconnectWindow: 0 }));

    await api.createStream(
      {
        request: new Request('http://test/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: 'ping' }),
        }),
      },
      async (stream) => {
        for await (const event of stream) return event;
        return undefined;
      },
    );
    await expectEventually(() => expect(structure.traces.at(-1)?.status).toBe('cancelled'));

    const record = await structure.getTrace(structure.traces.at(-1)?.traceId ?? '');
    expect(record?.runs.map((run) => [run.type, run.status])).toEqual(
      expect.arrayContaining([
        ['chain', 'cancelled'],
        ['agent', 'cancelled'],
      ]),
    );
  });

  it('keeps answering requests when the trace store is down', async () => {
    const { tracer, structure, payloads } = setup();
    structure.unavailable = true;
    payloads.unavailable = true;

    await expect(ask(tracer)).resolves.toMatchObject({ payload: { response: 'pong' } });
  });
});

async function expectEventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
