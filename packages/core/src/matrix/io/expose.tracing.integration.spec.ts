import { Effect, Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import type { NetworkTracer, RunTraceScope } from '../tracing/network-tracer.js';
import { noopRunTraceScope } from '../tracing/network-tracer.js';
import { registerSSEStream } from './proxy-consumer.js';

const requestEvent = AgentNetworkEvent.of('request', S.Struct({ request: S.String }));
const responseEvent = AgentNetworkEvent.of('response', S.Struct({ response: S.String }));

type Call = { hook: string; runId?: string; contextId?: string; error?: string };

/** Records every hook call; optionally fails every one of them. */
function recordingTracer(options: { fail?: 'throw' | 'reject' } = {}): {
  tracer: NetworkTracer;
  calls: Call[];
} {
  const calls: Call[] = [];
  const maybeFail = (): void => {
    if (options.fail === 'throw') throw new Error('tracer exploded');
  };
  const settle = async <T>(value: T): Promise<T> => {
    if (options.fail === 'reject') throw new Error('tracer rejected');
    return value;
  };
  const tracer: NetworkTracer = {
    onRunStart: (meta) => {
      calls.push({ hook: 'onRunStart', ...meta });
      maybeFail();
      return settle(undefined);
    },
    onRunEnd: (meta, error) => {
      calls.push({ hook: 'onRunEnd', ...meta, ...(error ? { error: error.message } : {}) });
      maybeFail();
      return settle(undefined);
    },
    onEventPublish: ({ name, meta }) => {
      calls.push({ hook: `publish:${name}`, runId: meta.runId, contextId: meta.contextId });
      maybeFail();
      return settle(undefined);
    },
    onAgentInvokeStart: ({ trigger }) => {
      calls.push({ hook: 'onAgentInvokeStart', ...trigger.meta });
      maybeFail();
      const scope: RunTraceScope = noopRunTraceScope(trigger.meta);
      return settle(scope);
    },
    onAgentInvokeEnd: (scope) => {
      calls.push({ hook: 'onAgentInvokeEnd', runId: scope.runId });
      maybeFail();
      return settle(undefined);
    },
    flush: () => {
      maybeFail();
      return settle(undefined);
    },
  };
  return { tracer, calls };
}

function echoNetwork(networkTracer: NetworkTracer) {
  return AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent }) => {
      const client = createChannel('client').proxy(proxy.sse());
      registerAgent(
        AgentFactory.run()
          .listensTo([requestEvent])
          .emits([responseEvent])
          .logic(async ({ triggerEvent, emit }) => {
            emit({
              name: 'response',
              payload: {
                response: `Echo: ${(triggerEvent.payload as { request: string }).request}`,
              },
            });
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client);
    },
    { networkTracer },
  );
}

async function ask(
  network: ReturnType<typeof echoNetwork>,
  options: { requestRunId?: string; startEventRunId?: string } = {},
): Promise<unknown> {
  const program = Effect.gen(function* () {
    const plane = yield* network.run();
    yield* Effect.sleep('10 millis');
    const api = network.expose(
      registerSSEStream({
        plane,
        channel: 'client',
        triggerEvents: [requestEvent],
        // The stream is dropped after its first event: cancel the run right away.
        reconnectWindow: 0,
        onRequest: ({ emitStartEvent, payload }) =>
          emitStartEvent({
            contextId: 'ctx-1',
            runId: options.startEventRunId ?? 'start-event-run',
            event: requestEvent.make(payload as { request: string }),
          }),
      }),
    );
    const request = new Request('http://test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: 'hi' }),
    });
    return yield* Effect.tryPromise(() =>
      api.createStream({ request, runId: options.requestRunId }, async (stream) => {
        for await (const event of stream) return event;
        return undefined;
      }),
    );
  });
  return Effect.runPromise(program.pipe(Effect.scoped));
}

describe('expose tracing', () => {
  test('starts and ends the traced run under the run id of the start event', async () => {
    const { tracer, calls } = recordingTracer();

    const received = await ask(echoNetwork(tracer), { startEventRunId: 'run-from-event' });

    expect(received).toMatchObject({ name: 'response', payload: { response: 'Echo: hi' } });
    const runIds = new Set(
      calls
        .filter((call) => ['onRunStart', 'onAgentInvokeStart', 'onRunEnd'].includes(call.hook))
        .map((call) => call.runId),
    );
    expect(runIds).toEqual(new Set(['run-from-event']));
    expect(calls.map((call) => call.hook)).toEqual(
      expect.arrayContaining(['onRunStart', 'publish:request', 'onAgentInvokeStart', 'onRunEnd']),
    );
    expect(calls.findIndex((call) => call.hook === 'onRunStart')).toBeLessThan(
      calls.findIndex((call) => call.hook === 'onAgentInvokeStart'),
    );
  });

  test.each([
    'throw',
    'reject',
  ] as const)('keeps serving requests when every tracer hook fails (%s)', async (fail) => {
    const { tracer, calls } = recordingTracer({ fail });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const received = await ask(echoNetwork(tracer));

      expect(received).toMatchObject({ name: 'response', payload: { response: 'Echo: hi' } });
      expect(calls.some((call) => call.hook === 'onAgentInvokeStart')).toBe(true);
    } finally {
      console.warn = warn;
    }
  });
});
