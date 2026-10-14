import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vitest } from 'vitest';
import { AgentFactory } from './agent-factory.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network/agent-network.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import type { Envelope } from './agent-network/event-plane.js';
import { type RunCompletedPayload, RunLifecycleEvent } from './agent-network/run-lifecycle.js';
import { registerSSEStream, type SseProxyConsumerOptions } from './io/proxy-consumer.js';
import type { ExposedStream } from './io/types.js';
import { Tool, type ToolExecutionContext } from './tool.js';
import {
  guardNetworkTracer,
  type NetworkTracer,
  type NetworkUsageEvent,
  noopRunTraceScope,
  type RunTraceScope,
} from './tracing/network-tracer.js';
import type { RunUsage, UsageReport } from './usage.js';

const request = AgentNetworkEvent.of('request', S.Struct({}));
const note = AgentNetworkEvent.of('note', S.Struct({ n: S.Number }));
const done = AgentNetworkEvent.of('done', S.Struct({}));

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

function post(): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** A tool that reports the usage it is called with. */
const embed = Tool.of({ name: 'embed', description: 'Embeds text' })
  .input(S.Struct({ inputTokens: S.Number, costUsd: S.Number }))
  .output(S.Struct({}))
  .define(({ input, reportUsage }) => {
    reportUsage({ inputTokens: input.inputTokens, costUsd: input.costUsd, model: 'embed-1' });
    return {};
  });

const agentFactory = AgentFactory.run().listensTo([request]).emits([note, done]).tools(embed);
type Logic = Parameters<typeof agentFactory.logic>[0];

/** One agent on main, publishing to an SSE client channel; the run ends on `done`. */
function usageNetwork(logic: Logic, options: AgentNetworkSetupOptions = {}) {
  let agentId = '';
  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
      const client = createChannel('client').proxy(proxy.sse());
      const agent = agentFactory.logic(logic).produce({});
      agentId = agent.getId();
      registerAgent(agent).subscribe(mainChannel).publishTo(client);
      endsOn(done);
    },
    options,
  );
  return { network, agentId: () => agentId };
}

function usageTracer() {
  const usageEvents: NetworkUsageEvent[] = [];
  const scopes: RunTraceScope[] = [];
  const tracer: NetworkTracer = {
    onRunStart: async () => {},
    onRunEnd: async () => {},
    onEventPublish: async () => {},
    onAgentInvokeStart: async ({ trigger }) => {
      const scope = noopRunTraceScope(trigger.meta);
      scopes.push(scope);
      return scope;
    },
    onAgentInvokeEnd: async () => {},
    onUsage: async (event) => {
      usageEvents.push(event);
    },
    flush: async () => {},
  };
  return { tracer, usageEvents, scopes };
}

const totals = (overrides: Partial<RunUsage> = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  ...overrides,
});

describe('usage', () => {
  test('reports from agents and tools add up per run, in total and per model', async () => {
    const { tracer, usageEvents, scopes } = usageTracer();
    const { network, agentId } = usageNetwork(
      async ({ reportUsage, tools, emit }) => {
        reportUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, model: 'gpt-x' });
        reportUsage({
          inputTokens: 50,
          outputTokens: 10,
          totalTokens: 65,
          cacheWriteTokens: 5,
          costUsd: 0.25,
          model: 'gpt-x',
        });
        // No model: counts toward the totals only.
        reportUsage({ totalTokens: 7, costUsd: 0.5 });
        await tools.toTools()[0]?.execute(
          { inputTokens: 30, costUsd: 0.125 },
          {
            toolCallId: 'call-1',
          },
        );
        emit(done.make({}));
      },
      { networkTracer: tracer },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [request] }));

    const events = await api.createStream({ request: post(), runId: 'run-1' }, collect);

    const expected: RunUsage = {
      ...totals({
        inputTokens: 180,
        outputTokens: 30,
        totalTokens: 120 + 65 + 7 + 30,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        costUsd: 0.875,
      }),
      byModel: {
        'gpt-x': totals({
          inputTokens: 150,
          outputTokens: 30,
          totalTokens: 185,
          cacheReadTokens: 40,
          cacheWriteTokens: 5,
          costUsd: 0.25,
        }),
        'embed-1': totals({ inputTokens: 30, totalTokens: 30, costUsd: 0.125 }),
      },
    };
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        name: RunLifecycleEvent.completed,
        payload: { reason: 'terminal-event', event: 'done', usage: expected },
      }),
    );

    // The tracer gets every report as it happens, attributed and with the running totals.
    expect(usageEvents.map((e) => e.usage)).toEqual([
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, model: 'gpt-x' },
      expect.objectContaining({ totalTokens: 65 }),
      { totalTokens: 7, costUsd: 0.5 },
      { inputTokens: 30, costUsd: 0.125, model: 'embed-1' },
    ]);
    expect(usageEvents[0]).toMatchObject({
      runId: 'run-1',
      agentId: agentId(),
      scope: scopes[0],
      runUsage: { totalTokens: 120 },
    });
    expect(usageEvents[0]).not.toHaveProperty('tool');
    expect(usageEvents[3]).toMatchObject({
      tool: { name: 'embed', toolCallId: 'call-1' },
      runUsage: expected,
    });
  });

  test('run-end payloads carry no usage when nothing was reported', async () => {
    const { network } = usageNetwork(async ({ emit }) => emit(done.make({})));
    const api = network.expose(registerSSEStream({ triggerEvents: [request] }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.at(-1)?.payload).toEqual({ reason: 'terminal-event', event: 'done' });
  });

  test('a failed run reports the usage spent before it failed', async () => {
    const { network } = usageNetwork(async ({ reportUsage }) => {
      reportUsage({ inputTokens: 10, outputTokens: 2 });
      throw new Error('model refused');
    });
    const api = network.expose(registerSSEStream({ triggerEvents: [request] }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.at(-1)).toMatchObject({
      name: RunLifecycleEvent.failed,
      payload: {
        error: { kind: 'agent-error' },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, byModel: {} },
      },
    });
  });

  test('invalid numbers in a report are ignored with a warning', async () => {
    const warn = vitest.spyOn(console, 'warn').mockImplementation(() => {});
    const { network } = usageNetwork(async ({ reportUsage, emit }) => {
      reportUsage({ inputTokens: Number.NaN, outputTokens: 3, costUsd: -1 });
      emit(done.make({}));
    });
    const api = network.expose(registerSSEStream({ triggerEvents: [request] }));

    const events = await api.createStream({ request: post() }, collect);

    expect((events.at(-1)?.payload as RunCompletedPayload).usage).toEqual({
      ...totals({ outputTokens: 3, totalTokens: 3 }),
      byModel: {},
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inputTokens, costUsd'));
    warn.mockRestore();
  });

  test('a throwing onUsage hook does not fail the run', async () => {
    const tracer: NetworkTracer = {
      ...usageTracer().tracer,
      onUsage: async () => {
        throw new Error('tracer down');
      },
    };
    const onError = vitest.fn();
    const { network } = usageNetwork(
      async ({ reportUsage, emit }) => {
        reportUsage({ outputTokens: 1 });
        emit(done.make({}));
      },
      { networkTracer: guardNetworkTracer(tracer, onError) },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [request] }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.at(-1)?.name).toBe(RunLifecycleEvent.completed);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'onUsage');
  });

  test('outside a network reportUsage is a no-op; a bound tool forwards it with its source', async () => {
    const agent = agentFactory
      .logic(async ({ reportUsage }) => reportUsage({ outputTokens: 1 }))
      .produce({});
    await expect(agent.invoke()).resolves.toBeUndefined();

    const reports: unknown[] = [];
    const bound = embed.bind({
      layers: {},
      reportUsage: (usage, source) => reports.push({ usage, source }),
    });
    await bound.execute({ inputTokens: 3, costUsd: 0 }, { toolCallId: 'call-9' });
    await embed.bind({ layers: {} }).execute({ inputTokens: 3, costUsd: 0 });

    expect(reports).toEqual([
      {
        usage: { inputTokens: 3, costUsd: 0, model: 'embed-1' },
        source: { tool: { name: 'embed', toolCallId: 'call-9' } },
      },
    ]);
  });
});

describe('usage budgets', () => {
  test('maxTokens fails the run once reports go over it, keeping the report that did', async () => {
    const { network, agentId } = usageNetwork(
      async ({ reportUsage, emit }) => {
        emit(note.make({ n: 1 }));
        reportUsage({ inputTokens: 50, outputTokens: 10 });
        reportUsage({ inputTokens: 40, outputTokens: 10 });
        // Already over budget: dropped with the run.
        emit(note.make({ n: 2 }));
        emit(done.make({}));
      },
      { maxTokens: 100 },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [request] }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.map((e) => e.name)).toEqual(['note', RunLifecycleEvent.failed]);
    expect(events.at(-1)?.payload).toEqual({
      agentId: agentId(),
      error: {
        name: 'RunLimitExceededError',
        message: expect.stringContaining('maxTokens'),
        kind: 'limit-exceeded',
        limit: 'tokens',
        max: 100,
      },
      usage: expect.objectContaining({ totalTokens: 110 }),
    });
  });

  test('maxCostUsd fails the run, also for usage a tool reports', async () => {
    const { network } = usageNetwork(async ({ tools, emit, signal }) => {
      const [tool] = tools.toTools();
      await tool?.execute({ inputTokens: 1, costUsd: 0.03 });
      await tool?.execute({ inputTokens: 1, costUsd: 0.03 });
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      emit(done.make({}));
    });
    const api = network.expose(registerSSEStream({ triggerEvents: [request], maxCostUsd: 0.05 }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.at(-1)).toMatchObject({
      name: RunLifecycleEvent.failed,
      payload: {
        error: { kind: 'limit-exceeded', limit: 'cost', max: 0.05 },
        usage: { costUsd: 0.06 },
      },
    });
  });

  test('budgets are off by default', async () => {
    const { network } = usageNetwork(async ({ reportUsage, emit }) => {
      reportUsage({ totalTokens: 1e9, costUsd: 1e6 });
      emit(done.make({}));
    });
    const api = network.expose(registerSSEStream({ triggerEvents: [request] }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.at(-1)?.name).toBe(RunLifecycleEvent.completed);
  });
});

describe('usage types', () => {
  test('reportUsage takes a UsageReport on agent logic and tool contexts', () => {
    agentFactory.logic(async ({ reportUsage }) => {
      expectTypeOf(reportUsage).parameters.toEqualTypeOf<[usage: UsageReport]>();
      expectTypeOf(reportUsage).returns.toEqualTypeOf<void>();
    });
    expectTypeOf<ToolExecutionContext<unknown, unknown>['reportUsage']>().toEqualTypeOf<
      (usage: UsageReport) => void
    >();
    expectTypeOf<UsageReport>().toEqualTypeOf<{
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      model?: string;
    }>();
  });

  test('onUsage is optional on NetworkTracer; run-end payloads may carry usage', () => {
    expectTypeOf<NetworkTracer['onUsage']>().toEqualTypeOf<
      ((event: NetworkUsageEvent) => Promise<void>) | undefined
    >();
    expectTypeOf<RunCompletedPayload['usage']>().toEqualTypeOf<RunUsage | undefined>();
    expectTypeOf<SseProxyConsumerOptions['maxTokens']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AgentNetworkSetupOptions['maxCostUsd']>().toEqualTypeOf<number | undefined>();
  });
});
