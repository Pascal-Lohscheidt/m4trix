// @vitest-environment node
import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from './agent-factory.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network/agent-network.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import type { Envelope } from './agent-network/event-plane.js';
import { RunLifecycleEvent } from './agent-network/run-lifecycle.js';
import type { AgentNetworkStore } from './agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './agent-network/stores/inmemory-network-store.js';
import type { NetworkMetric, NetworkMetricName } from './index.js';
import { registerSSEStream } from './io/proxy-consumer.js';
import type { ExposedStream } from './io/types.js';

const start = AgentNetworkEvent.of('start', S.Struct({ secret: S.String }));
const step = AgentNetworkEvent.of('step', S.Struct({ n: S.Number }));
const tick = AgentNetworkEvent.of('tick', S.Struct({}), { transient: true });
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

const post = (payload: unknown): Request =>
  new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

const quiet = { warn: () => {}, error: () => {} };

/**
 * start -> worker (emits step, tick, answer) on client; a second agent listens to step, so step
 * events queue in its mailbox.
 */
function metricsNetwork(
  logic: Parameters<ReturnType<typeof worker>['logic']>[0],
  options: AgentNetworkSetupOptions,
) {
  return AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    const steps = createChannel('steps');
    const agent = worker().logic(logic).produce({});
    registerAgent(agent).subscribe(mainChannel).publishTo(client).publishTo(steps);
    registerAgent(
      AgentFactory.run()
        .listensTo([step])
        .logic(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        })
        .produce({}),
    ).subscribe(steps);
    endsOn(answer);
  }, options);
}

const worker = () => AgentFactory.run().listensTo([start]).emits([step, tick, answer]);

const byName = <N extends NetworkMetricName>(metrics: NetworkMetric[], name: N) =>
  metrics.filter((m): m is Extract<NetworkMetric, { name: N }> => m.name === name);

describe('metrics hook (onMetric)', () => {
  test('a completed run reports its duration, events, usage, invocations, mailbox depth and store writes', async () => {
    const metrics: NetworkMetric[] = [];
    const network = metricsNetwork(
      async ({ emit, reportUsage }) => {
        for (let n = 0; n < 3; n++) emit(step.make({ n }));
        emit(tick.make({}));
        reportUsage({ inputTokens: 10, outputTokens: 5, costUsd: 0.25, model: 'm' });
        emit(answer.make({ text: 'done' }));
      },
      { onMetric: (metric) => metrics.push(metric), logger: quiet },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));

    const events = await api.createStream(
      { request: post({ secret: 'top-secret' }), runId: 'r1', contextId: 'c1' },
      collect,
    );
    expect(events.at(-1)?.name).toBe(RunLifecycleEvent.completed);

    const [duration] = byName(metrics, 'm4trix.run.duration_ms');
    expect(duration).toMatchObject({
      kind: 'histogram',
      unit: 'ms',
      attributes: { status: 'completed', reason: 'terminal-event' },
    });
    expect(duration?.value).toBeGreaterThanOrEqual(0);

    expect(byName(metrics, 'm4trix.run.events')).toEqual([
      {
        name: 'm4trix.run.events',
        kind: 'histogram',
        unit: '{event}',
        value: 5, // start, 3 steps, answer
        attributes: { status: 'completed', durability: 'durable' },
      },
      {
        name: 'm4trix.run.events',
        kind: 'histogram',
        unit: '{event}',
        value: 1,
        attributes: { status: 'completed', durability: 'transient' },
      },
    ]);

    expect(byName(metrics, 'm4trix.run.tokens').map((m) => [m.attributes.type, m.value])).toEqual([
      ['input', 10],
      ['output', 5],
      ['total', 15],
    ]);
    expect(byName(metrics, 'm4trix.run.cost_usd')).toEqual([
      {
        name: 'm4trix.run.cost_usd',
        kind: 'histogram',
        unit: 'USD',
        value: 0.25,
        attributes: { status: 'completed' },
      },
    ]);

    const invocations = byName(metrics, 'm4trix.agent.invocation.duration_ms');
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    for (const invocation of invocations) {
      expect(invocation).toMatchObject({ kind: 'histogram', unit: 'ms' });
      expect(invocation.attributes.agentId).toMatch(/^agent-/);
      expect(['ok', 'cancelled']).toContain(invocation.attributes.status);
    }

    const depths = byName(metrics, 'm4trix.mailbox.depth');
    expect(depths.length).toBeGreaterThanOrEqual(4); // start + 3 steps enqueued
    expect(Math.max(...depths.map((m) => m.value))).toBeGreaterThanOrEqual(1);
    expect(depths[0]).toMatchObject({ kind: 'histogram', unit: '{event}' });

    const writes = byName(metrics, 'm4trix.store.append.duration_ms');
    expect(writes.length).toBe(6); // 5 durable events + run.completed
    expect(writes.every((m) => m.attributes.status === 'ok')).toBe(true);

    // Never payload contents, run ids or principals.
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('"r1"');
    expect(serialized).not.toContain('"c1"');
  });

  test('a failing agent reports error invocations and a failed run with its kind', async () => {
    const metrics: NetworkMetric[] = [];
    const network = metricsNetwork(
      async () => {
        throw new Error('boom');
      },
      { onMetric: (metric) => metrics.push(metric), logger: quiet },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));

    await api.createStream({ request: post({ secret: 's' }) }, collect);

    expect(byName(metrics, 'm4trix.agent.invocation.duration_ms')).toEqual([
      expect.objectContaining({
        attributes: { agentId: expect.stringMatching(/^agent-/), status: 'error' },
      }),
    ]);
    expect(byName(metrics, 'm4trix.run.duration_ms')).toEqual([
      expect.objectContaining({ attributes: { status: 'failed', reason: 'agent-error' } }),
    ]);
    // No usage reported: no usage metrics.
    expect(byName(metrics, 'm4trix.run.tokens')).toEqual([]);
  });

  test('store write failures are counted per attempt and the write reports its outcome', async () => {
    const metrics: NetworkMetric[] = [];
    const inner = createInMemoryNetworkStore();
    const store: AgentNetworkStore = {
      ...inner,
      append: async (key, event) => {
        if (event.name === 'answer') throw new Error('db down');
        return inner.append(key, event);
      },
    };
    const network = metricsNetwork(
      async ({ emit }) => {
        emit(answer.make({ text: 'x' }));
      },
      { onMetric: (metric) => metrics.push(metric), logger: quiet, store },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));

    const events = await api.createStream({ request: post({ secret: 's' }) }, collect);
    expect(events.at(-1)).toMatchObject({
      name: RunLifecycleEvent.failed,
      payload: { error: { kind: 'store-error' } },
    });

    expect(byName(metrics, 'm4trix.store.append.errors').map((m) => m.attributes.final)).toEqual([
      false,
      false,
      true,
    ]);
    expect(
      byName(metrics, 'm4trix.store.append.duration_ms').map((m) => m.attributes.status),
    ).toContain('error');
    expect(byName(metrics, 'm4trix.run.duration_ms')).toEqual([
      expect.objectContaining({ attributes: { status: 'failed', reason: 'store-error' } }),
    ]);
  });

  test('a cancelled run reports its cancel reason', async () => {
    const metrics: NetworkMetric[] = [];
    const network = metricsNetwork(
      async ({ signal }) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
      { onMetric: (metric) => metrics.push(metric), logger: quiet },
    );
    const api = network.expose(registerSSEStream({ reconnectWindow: 0, triggerEvents: [start] }));
    const controller = new AbortController();
    const request = new Request('http://test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 's' }),
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 20);
    await api.createStream({ request }, collect);

    expect(byName(metrics, 'm4trix.run.duration_ms')).toEqual([
      expect.objectContaining({ attributes: { status: 'cancelled', reason: 'client-abort' } }),
    ]);
  });

  test('a throwing onMetric never breaks a run, and is logged once', async () => {
    const warn = vi.fn();
    const network = metricsNetwork(
      async ({ emit }) => {
        emit(step.make({ n: 1 }));
        emit(answer.make({ text: 'ok' }));
      },
      {
        onMetric: () => {
          throw new Error('metrics backend down');
        },
        logger: { warn },
      },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));

    const events = await api.createStream({ request: post({ secret: 's' }) }, collect);
    const again = await api.createStream({ request: post({ secret: 's' }) }, collect);

    expect(events.map((e) => e.name)).toEqual(['step', 'answer', RunLifecycleEvent.completed]);
    expect(again.at(-1)?.name).toBe(RunLifecycleEvent.completed);
    const metricWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('onMetric'),
    );
    expect(metricWarnings).toHaveLength(1);
  });

  test('network.run() planes report too', async () => {
    const metrics: NetworkMetric[] = [];
    const network = metricsNetwork(
      async ({ emit }) => {
        emit(answer.make({ text: 'ok' }));
      },
      { onMetric: (metric) => metrics.push(metric), logger: quiet },
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const main = network.getMainChannel();
          if (!main) throw new Error('no main channel');
          yield* plane.publish(main.name, {
            name: 'start',
            meta: { runId: 'r', contextId: 'c' },
            payload: { secret: 's' },
          });
          yield* plane.awaitRunEnd('r');
        }),
      ),
    );

    expect(byName(metrics, 'm4trix.run.duration_ms')).toHaveLength(1);
  });

  test('types', () => {
    expectTypeOf<NetworkMetricName>().toEqualTypeOf<
      | 'm4trix.run.duration_ms'
      | 'm4trix.run.events'
      | 'm4trix.run.tokens'
      | 'm4trix.run.cost_usd'
      | 'm4trix.agent.invocation.duration_ms'
      | 'm4trix.mailbox.depth'
      | 'm4trix.store.append.duration_ms'
      | 'm4trix.store.append.errors'
      | 'm4trix.fold.read.events'
    >();
    expectTypeOf<AgentNetworkSetupOptions['onMetric']>().toEqualTypeOf<
      ((metric: NetworkMetric) => void) | undefined
    >();
    const handle = (metric: NetworkMetric): void => {
      if (metric.name === 'm4trix.fold.read.events') {
        expectTypeOf(metric.attributes).toEqualTypeOf<{
          readonly fold: string;
          readonly start: 'cold' | 'warm' | 'reset';
        }>();
        expectTypeOf(metric.unit).toEqualTypeOf<'{event}'>();
        expectTypeOf(metric.kind).toEqualTypeOf<'histogram'>();
      }
      if (metric.name === 'm4trix.agent.invocation.duration_ms') {
        expectTypeOf(metric.attributes).toEqualTypeOf<{
          readonly agentId: string;
          readonly status: 'ok' | 'error' | 'cancelled';
        }>();
        expectTypeOf(metric.unit).toEqualTypeOf<'ms'>();
      }
      if (metric.name === 'm4trix.run.duration_ms') {
        expectTypeOf(metric.attributes.status).toEqualTypeOf<
          'completed' | 'failed' | 'cancelled'
        >();
      }
      expectTypeOf(metric.value).toEqualTypeOf<number>();
      expectTypeOf(metric.kind).toEqualTypeOf<'histogram' | 'counter'>();
    };
    void handle;
  });
});
