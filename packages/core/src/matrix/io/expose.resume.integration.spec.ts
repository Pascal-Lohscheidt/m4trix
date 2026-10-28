import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import { ContextFold } from '../context/context-fold.js';
import type { Envelope } from '../agent-network/event-plane.js';
import { DEFAULT_RECONNECT_WINDOW, RunLifecycleEvent } from '../agent-network/run-lifecycle.js';
import type { AgentNetworkStore } from '../agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import type { NetworkMetric } from '../metrics.js';
import { type NetworkTracer, noopNetworkTracer } from '../tracing/network-tracer.js';
import { ExpressEndpoint, type ExpressRequest } from './adapters/express-endpoint.js';
import { NextEndpoint } from './adapters/next-endpoint.js';
import { ExposeRunNotFoundError, type ExposeRunNotFoundErrorBody } from './expose.js';
import { registerSSEStream, type SseProxyConsumerOptions } from './proxy-consumer.js';
import type { AuthResult, ExposedStream, ExposeRequest } from './types.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const progress = AgentNetworkEvent.of('progress', S.Struct({ step: S.Number }));
const delta = AgentNetworkEvent.of('delta', S.Struct({ text: S.String }), { transient: true });
const internal = AgentNetworkEvent.of('internal', S.Struct({}));
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));

type Seen = { name: string; id: string | undefined; payload: unknown };

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * start -> worker: two progress events (durable) and deltas (transient) on client, an internal
 * event on a side channel, then waits for `release` and answers (terminal).
 */
function resumeNetwork(options: AgentNetworkSetupOptions = {}) {
  const release = gate();
  const counts = { invocations: 0, appends: [] as string[], runStarts: 0 };
  const inner = createInMemoryNetworkStore();
  const store: AgentNetworkStore = {
    ...inner,
    append: (key, event) => {
      counts.appends.push(event.name);
      return inner.append(key, event);
    },
  };
  const networkTracer: NetworkTracer = {
    ...noopNetworkTracer,
    onRunStart: async () => {
      counts.runStarts++;
    },
  };
  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
      const client = createChannel('client').proxy(proxy.sse()).events([progress, delta, answer]);
      const side = createChannel('side').events([internal]);
      registerAgent(
        AgentFactory.run()
          .listensTo([start])
          .emits([progress, delta, internal, answer])
          .logic(async ({ emit }) => {
            counts.invocations++;
            emit(progress.make({ step: 1 }));
            emit(delta.make({ text: 'a' }));
            emit(internal.make({}));
            emit(progress.make({ step: 2 }));
            emit(delta.make({ text: 'b' }));
            await release.wait;
            emit(answer.make({ text: 'done' }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client)
        .publishTo(side);
      registerAgent(
        AgentFactory.run()
          .listensTo([internal])
          .logic(async () => {})
          .produce({}),
      ).subscribe(side);
      endsOn(answer);
    },
    { store, networkTracer, ...options },
  );
  return { network, release, counts, store: inner };
}

const post = (signal?: AbortSignal): Request =>
  new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  });

/** Reads `stream` (with SSE ids) until it ends, or until `stopAfter` returns true. */
function reader(stopAfter?: (seen: Seen[]) => boolean) {
  const seen: Seen[] = [];
  let startId: string | undefined;
  const consume = async (stream: ExposedStream): Promise<Seen[]> => {
    startId = stream.startId;
    for await (const envelope of stream) {
      seen.push({ name: envelope.name, id: stream.idOf?.(envelope), payload: envelope.payload });
      if (stopAfter?.(seen)) break;
    }
    return seen;
  };
  return { seen, consume, startId: () => startId };
}

const resumeRequest = (lastEventId: string, extra: Partial<ExposeRequest> = {}): ExposeRequest => ({
  request: new Request('http://test/api', { headers: { 'Last-Event-ID': lastEventId } }),
  ...extra,
});

const headerAuth = (req: ExposeRequest): AuthResult => {
  const user = req.request?.headers.get('x-user');
  return user ? { allowed: true, principal: { id: user } } : { allowed: false };
};

describe('SSE resume (Last-Event-ID)', () => {
  test('streams carry an SSE id per durable event and a start id; transient events have none', async () => {
    const { network, release } = resumeNetwork();
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
    release.open();
    const r = reader();

    const seen = await api.createStream(
      { request: post(), contextId: 'ctx', runId: 'run-1' },
      r.consume,
    );

    expect(seen.map((s) => s.name)).toEqual([
      'progress',
      'delta',
      'progress',
      'delta',
      'answer',
      RunLifecycleEvent.completed,
    ]);
    for (const s of seen) {
      if (s.name === 'delta') expect(s.id).toBeUndefined();
      else expect(s.id).toMatch(/^ctx\/run-1\/[\w-]+$/);
    }
    expect(new Set(seen.map((s) => s.id).filter(Boolean)).size).toBe(4);
    expect(r.startId()).toMatch(/^ctx\/run-1\/[\w-]+$/);
  });

  test('NextEndpoint writes the ids: the start position first, then one per durable event', async () => {
    const { network, release } = resumeNetwork();
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
    release.open();
    const handler = NextEndpoint.from(api, {
      requestToContextId: () => 'ctx',
      requestToRunId: () => 'run-1',
    }).handler();

    const text = await (await handler(post())).text();

    const messages = text.split('\n\n').filter(Boolean);
    expect(messages[0]).toMatch(/^id: ctx\/run-1\/[\w-]+$/);
    const deltas = messages.filter((m) => m.includes('event: delta'));
    expect(deltas).toHaveLength(2);
    for (const m of deltas) expect(m).not.toMatch(/^id:/m);
    for (const m of messages.filter((m) => m.includes('event: progress'))) {
      expect(m).toMatch(/^id: ctx\/run-1\/[\w-]+\nevent: progress\n/);
    }
  });

  test('resuming an ended run replays only its durable stream events after the id, ending with its run-end event', async () => {
    const { network, release, counts } = resumeNetwork();
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
    release.open();
    const first = await api.createStream(
      { request: post(), contextId: 'ctx', runId: 'run-1' },
      reader().consume,
    );
    const firstProgress = first.find((s) => s.name === 'progress')?.id ?? '';
    const appendsBefore = counts.appends.length;

    const resumed = await api.createStream(resumeRequest(firstProgress), reader().consume);

    expect(resumed.map((s) => [s.name, s.payload])).toEqual([
      ['progress', { step: 2 }],
      ['answer', { text: 'done' }],
      [RunLifecycleEvent.completed, expect.objectContaining({ reason: 'terminal-event' })],
    ]);
    expect(resumed.map((s) => s.id)).toEqual(
      first
        .filter((s) => s.id)
        .slice(1)
        .map((s) => s.id),
    );
    // Nothing ran again: no run, no start event, no agent invocation.
    expect(counts.appends.length).toBe(appendsBefore);
    expect(counts.invocations).toBe(1);
    expect(counts.runStarts).toBe(1);
  });

  test('resuming at the start position replays every stream event; at the run-end event it is sent again', async () => {
    const { network, release } = resumeNetwork();
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
    release.open();
    const r = reader();
    const first = await api.createStream(
      { request: post(), contextId: 'c', runId: 'r' },
      r.consume,
    );

    const fromStart = await api.createStream(resumeRequest(r.startId() ?? ''), reader().consume);
    const fromEnd = await api.createStream(resumeRequest(first.at(-1)?.id ?? ''), reader().consume);

    expect(fromStart.map((s) => s.name)).toEqual([
      'progress',
      'progress',
      'answer',
      RunLifecycleEvent.completed,
    ]);
    expect(fromEnd.map((s) => [s.name, s.id])).toEqual([
      [RunLifecycleEvent.completed, first.at(-1)?.id],
    ]);
  });

  test('a fold checkpoint is never replayed, also from a store that drops channels', async () => {
    const Log = ContextFold.of('log', { state: S.Array(S.String) })
      .initial(() => [])
      .on(start, (lines) => [...lines, 'start']);
    const inner = createInMemoryNetworkStore();
    // A store that loses `channels`: a resume falls back to the event's name and depth.
    const store: AgentNetworkStore = {
      ...inner,
      append: (key, { channels: _dropped, ...event }) => inner.append(key, event),
    };
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
        const client = createChannel('client').proxy(proxy.sse()).events([progress, answer]);
        registerAgent(
          AgentFactory.run()
            .listensTo([start])
            .emits([progress, answer])
            .folds([Log])
            .logic(async ({ folds, emit }) => {
              await folds.log.compact(() => ['summary']);
              emit(progress.make({ step: 1 }));
              emit(answer.make({ text: 'done' }));
            })
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(client);
        endsOn(answer);
      },
      { store },
    );
    const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
    const r = reader();
    await api.createStream({ request: post(), contextId: 'c', runId: 'r' }, r.consume);

    const replayed = await api.createStream(resumeRequest(r.startId() ?? ''), reader().consume);

    expect(
      (await inner.readRun({ namespace: 'anonymous', contextId: 'c' }, 'r')).map((e) => e.name),
    ).toContain('m4trix:fold.checkpoint:log@1');
    expect(replayed.map((s) => s.name)).toEqual([
      'progress',
      'answer',
      RunLifecycleEvent.completed,
    ]);
  });

  test('a resume ignores the request payload and never calls onRequest', async () => {
    const { network, release, counts } = resumeNetwork();
    let onRequestCalls = 0;
    const api = network.expose(
      registerSSEStream({
        triggerEvents: [start],
        onRequest: ({ emitStartEvent, req }) => {
          onRequestCalls++;
          emitStartEvent({
            contextId: req.contextId ?? 'c',
            runId: req.runId ?? 'r',
            event: start.make({}),
          });
        },
      }),
    );
    release.open();
    const r = reader();
    await api.createStream({ request: post(), contextId: 'c', runId: 'r' }, r.consume);

    const resumed = await api.createStream(
      {
        request: new Request(`http://test/api?payload=${encodeURIComponent('not json')}`, {
          headers: { 'Last-Event-ID': r.startId() ?? '' },
        }),
      },
      reader().consume,
    );

    expect(resumed.at(-1)?.name).toBe(RunLifecycleEvent.completed);
    expect(onRequestCalls).toBe(1);
    expect(counts.invocations).toBe(1);
  });

  describe('a run still going', () => {
    test('with a reconnect window, a dropped stream keeps its run alive and a resume continues live', async () => {
      const { network, release, counts } = resumeNetwork();
      const api = network.expose(
        registerSSEStream({ triggerEvents: [start], reconnectWindow: '5 seconds' }),
      );
      const controller = new AbortController();
      const first = reader((seen) => seen.filter((s) => s.name === 'progress').length === 2);
      const firstRun = api.createStream(
        { request: post(controller.signal), contextId: 'c', runId: 'r' },
        async (stream) => {
          await first.consume(stream);
          controller.abort(); // the client goes away
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      const lastSeen = first.seen.find((s) => s.name === 'progress')?.id ?? '';

      const second = reader();
      const resumed = api.createStream(resumeRequest(lastSeen), second.consume);
      await new Promise((resolve) => setTimeout(resolve, 30));
      release.open();

      expect((await resumed).map((s) => s.name)).toEqual([
        'progress',
        'answer',
        RunLifecycleEvent.completed,
      ]);
      await firstRun;
      expect(counts.invocations).toBe(1);
      expect(counts.appends.filter((name) => name === 'start')).toHaveLength(1);
    });

    test('on a shared plane a resume continues live too', async () => {
      const { network, release } = resumeNetwork();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const plane = yield* network.run();
            const api = network.expose(
              registerSSEStream({
                plane,
                triggerEvents: [start],
                reconnectWindow: '5 seconds',
                // On a shared plane a stream starts its run through onRequest.
                onRequest: ({ emitStartEvent, req }) =>
                  emitStartEvent({
                    contextId: req.contextId ?? 'c',
                    runId: req.runId ?? 'r',
                    event: start.make({}),
                  }),
              }),
            );
            const controller = new AbortController();
            const first = reader((seen) => seen.length >= 1);
            const firstRun = api.createStream(
              { request: post(controller.signal), contextId: 'c', runId: 'shared-run' },
              async (stream) => {
                await first.consume(stream);
                controller.abort();
              },
            );
            yield* Effect.sleep('30 millis');

            const resumed = api.createStream(
              resumeRequest(first.seen[0]?.id ?? ''),
              reader().consume,
            );
            yield* Effect.sleep('30 millis');
            release.open();
            const names = (yield* Effect.promise(() => resumed)).map((s) => s.name);
            yield* Effect.promise(() => firstRun);

            // Deltas published before the resume are not replayed (they are never stored).
            expect(names).toEqual(['progress', 'answer', RunLifecycleEvent.completed]);
          }),
        ),
      );
    });

    test('the default reconnect window is 30 seconds', () => {
      expect(DEFAULT_RECONNECT_WINDOW).toBe('30 seconds');
      expectTypeOf<typeof DEFAULT_RECONNECT_WINDOW>().toEqualTypeOf<'30 seconds'>();
    });

    test('by default a dropped stream keeps its run alive and a resume continues live', async () => {
      const { network, release, counts } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
      const controller = new AbortController();
      const first = reader((seen) => seen.filter((s) => s.name === 'progress').length === 2);
      const firstRun = api.createStream(
        { request: post(controller.signal), contextId: 'c', runId: 'r' },
        async (stream) => {
          await first.consume(stream);
          controller.abort();
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      const lastSeen = first.seen.find((s) => s.name === 'progress')?.id ?? '';

      const resumed = api.createStream(resumeRequest(lastSeen), reader().consume);
      await new Promise((resolve) => setTimeout(resolve, 30));
      release.open();

      expect((await resumed).map((s) => s.name)).toEqual([
        'progress',
        'answer',
        RunLifecycleEvent.completed,
      ]);
      await firstRun;
      expect(counts.invocations).toBe(1);
    });

    test('by default a run nobody resumes is cancelled 30 seconds after its stream dropped', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const runEnds: Array<{ status: string }> = [];
        const metrics: NetworkMetric[] = [];
        const signals: AbortSignal[] = [];
        const network = AgentNetwork.setup(
          ({ mainChannel, createChannel, proxy, registerAgent }) => {
            const client = createChannel('client').proxy(proxy.sse()).events([progress]);
            registerAgent(
              AgentFactory.run()
                .listensTo([start])
                .emits([progress])
                .logic(async ({ emit, signal }) => {
                  signals.push(signal);
                  emit(progress.make({ step: 1 }));
                  await new Promise<void>((resolve) =>
                    signal.addEventListener('abort', () => resolve()),
                  );
                })
                .produce({}),
            )
              .subscribe(mainChannel)
              .publishTo(client);
          },
          {
            networkTracer: {
              ...noopNetworkTracer,
              onRunEnd: async (_meta, _error, options) => {
                runEnds.push({ status: options?.status ?? 'unknown' });
              },
            },
            onMetric: (metric) => metrics.push(metric),
          },
        );
        const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
        const controller = new AbortController();
        const r = reader((seen) => seen.length >= 1);
        let settled = false;
        const firstRun = api
          .createStream(
            { request: post(controller.signal), contextId: 'c', runId: 'r' },
            async (s) => {
              await r.consume(s);
              controller.abort();
            },
          )
          .finally(() => {
            settled = true;
          });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(r.seen.map((s) => s.name)).toEqual(['progress']);

        // Within the window the run (and its agent) keeps going.
        await vi.advanceTimersByTimeAsync(28_000);
        expect(settled).toBe(false);
        expect(signals[0]?.aborted).toBe(false);
        expect(runEnds).toEqual([]);

        // Past it, the run is cancelled: agents abort, the tracer and metrics report the cancel.
        await vi.advanceTimersByTimeAsync(2_000);
        await firstRun;
        expect(signals[0]?.aborted).toBe(true);
        expect(runEnds).toEqual([{ status: 'cancelled' }]);
        expect(metrics).toContainEqual(
          expect.objectContaining({
            name: 'm4trix.run.duration_ms',
            attributes: { status: 'cancelled', reason: 'client-abort' },
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    test('with a reconnect window of 0 a dropped stream cancels its run; a resume ends with that', async () => {
      const { network } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start], reconnectWindow: 0 }));
      const controller = new AbortController();
      const first = reader((seen) => seen.length >= 1);
      await api.createStream(
        { request: post(controller.signal), contextId: 'c', runId: 'r' },
        async (stream) => {
          await first.consume(stream);
          controller.abort();
        },
      );

      const resumed = await api.createStream(
        resumeRequest(first.seen[0]?.id ?? ''),
        reader().consume,
      );

      expect(resumed.at(-1)).toMatchObject({
        name: RunLifecycleEvent.cancelled,
        payload: { reason: 'client-abort' },
      });
    });

    test('when nobody resumes within the window, the run is cancelled', async () => {
      const { network } = resumeNetwork();
      const api = network.expose(
        registerSSEStream({ triggerEvents: [start], reconnectWindow: '30 millis' }),
      );
      const controller = new AbortController();
      const r = reader((seen) => seen.length >= 1);

      await api.createStream(
        { request: post(controller.signal), contextId: 'c', runId: 'r' },
        async (stream) => {
          await r.consume(stream);
          controller.abort();
        },
      );
      const resumed = await api.createStream(resumeRequest(r.seen[0]?.id ?? ''), reader().consume);

      expect(resumed.at(-1)).toMatchObject({
        name: RunLifecycleEvent.cancelled,
        payload: { reason: 'client-abort' },
      });
    });
  });

  describe('tenancy', () => {
    test("a resume never replays another principal's run", async () => {
      const { network, release } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start], auth: headerAuth }));
      release.open();
      const alice = new Request('http://test/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user': 'alice' },
        body: '{}',
      });
      const r = reader();
      await api.createStream({ request: alice, contextId: 'c', runId: 'r' }, r.consume);
      const position = r.startId() ?? '';

      const asBob = await api
        .createStream(
          {
            request: new Request('http://test/api', {
              headers: { 'Last-Event-ID': position, 'x-user': 'bob' },
            }),
          },
          reader().consume,
        )
        .catch((e: unknown) => e);
      const asAlice = await api.createStream(
        {
          request: new Request('http://test/api', {
            headers: { 'Last-Event-ID': position, 'x-user': 'alice' },
          }),
        },
        reader().consume,
      );

      expect(asBob).toBeInstanceOf(ExposeRunNotFoundError);
      expect(asAlice.at(-1)?.name).toBe(RunLifecycleEvent.completed);
    });

    test('a live run of another principal is not found either', async () => {
      const { network, release } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start], auth: headerAuth }));
      const r = reader((seen) => seen.length >= 1);
      const running = api.createStream(
        {
          request: new Request('http://test/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user': 'alice' },
            body: '{}',
          }),
          contextId: 'c',
          runId: 'r',
        },
        async (stream) => {
          await r.consume(stream);
          release.open();
          for await (const _ of stream) {
            // drain to the end
          }
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      const asBob = await api
        .createStream(
          {
            request: new Request('http://test/api', {
              headers: { 'Last-Event-ID': r.seen[0]?.id ?? '', 'x-user': 'bob' },
            }),
          },
          reader().consume,
        )
        .catch((e: unknown) => e);
      await running;

      expect(asBob).toBeInstanceOf(ExposeRunNotFoundError);
    });
  });

  describe('unknown runs', () => {
    test('an unknown run, an unknown position or a malformed id is a 404 (ExposeRunNotFoundError)', async () => {
      const { network, release } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
      release.open();
      const r = reader();
      await api.createStream({ request: post(), contextId: 'c', runId: 'r' }, r.consume);

      for (const id of [
        'c/unknown-run/x',
        'c/r/not-an-event',
        'garbage',
        'a/b/c/d',
        '%E0%A4%A/r/x',
      ]) {
        const error = await api.createStream(resumeRequest(id)).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ExposeRunNotFoundError);
        expect((error as ExposeRunNotFoundError).status).toBe(404);
        expect((error as ExposeRunNotFoundError).toJSON()).toEqual({ error: 'run_not_found' });
      }

      const handler = NextEndpoint.from(api, {
        requestToContextId: () => 'c',
        requestToRunId: () => 'r',
      }).handler();
      const response = await handler(
        new Request('http://test/api', { headers: { 'Last-Event-ID': 'c/unknown-run/x' } }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'run_not_found' });
    });

    test('a run with stored events but neither live here nor ended ends with run.failed (run-unavailable)', async () => {
      const { network, store } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
      const key = { namespace: 'anonymous', contextId: 'c' };
      const meta = (eventId: string) => ({ runId: 'elsewhere', contextId: 'c', eventId });
      await store.append(key, { name: 'start', meta: meta('e0'), payload: {}, channels: ['main'] });
      await store.append(key, {
        name: 'progress',
        meta: meta('e1'),
        payload: { step: 1 },
        channels: ['client', 'side'],
      });

      const resumed = await api.createStream(resumeRequest('c/elsewhere/e0'), reader().consume);

      expect(resumed.map((s) => [s.name, s.id])).toEqual([
        ['progress', 'c/elsewhere/e1'],
        [RunLifecycleEvent.failed, undefined],
      ]);
      expect(resumed.at(-1)?.payload).toMatchObject({ error: { kind: 'run-unavailable' } });
    });
  });

  describe('adapters', () => {
    test('NextEndpoint resumes from ?lastEventId= (EventSource polyfills)', async () => {
      const { network, release } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
      release.open();
      const r = reader();
      await api.createStream({ request: post(), contextId: 'c', runId: 'r' }, r.consume);
      const handler = NextEndpoint.from(api, {
        requestToContextId: () => 'c',
        requestToRunId: () => 'r',
      }).handler();

      const text = await (
        await handler(
          new Request(`http://test/api?lastEventId=${encodeURIComponent(r.startId() ?? '')}`),
        )
      ).text();

      expect(text.match(/^event: .*/gm)).toEqual([
        'event: progress',
        'event: progress',
        'event: answer',
        `event: ${RunLifecycleEvent.completed}`,
      ]);
    });

    test('ExpressEndpoint resumes from the Last-Event-ID header or ?lastEventId=', async () => {
      const { network, release } = resumeNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [start] }));
      release.open();
      const r = reader();
      await api.createStream({ request: post(), contextId: 'c', runId: 'r' }, r.consume);
      const handler = ExpressEndpoint.from(api, {
        requestToContextId: () => 'c',
        requestToRunId: () => 'r',
      }).handler();
      const position = r.startId() ?? '';

      const viaHeader = expressRes();
      await handler(
        { method: 'GET', headers: { 'last-event-id': position }, on: () => {} } as ExpressRequest,
        viaHeader,
      );
      const viaQuery = expressRes();
      await handler(
        {
          method: 'GET',
          headers: {},
          query: { lastEventId: position },
          on: () => {},
        } as ExpressRequest,
        viaQuery,
      );
      const unknown = expressRes();
      await handler(
        { method: 'GET', headers: { 'last-event-id': 'c/nope/x' }, on: () => {} } as ExpressRequest,
        unknown,
      );

      for (const res of [viaHeader, viaQuery]) {
        expect(res.body.match(/^event: .*/gm)).toEqual([
          'event: progress',
          'event: progress',
          'event: answer',
          `event: ${RunLifecycleEvent.completed}`,
        ]);
      }
      expect(unknown.statusCode).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({ error: 'run_not_found' });
    });
  });

  test('types', () => {
    expectTypeOf<ExposeRequest['lastEventId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ExposedStream['idOf']>().toEqualTypeOf<
      ((envelope: Envelope) => string | undefined) | undefined
    >();
    expectTypeOf<ExposedStream['startId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ExposeRunNotFoundErrorBody>().toEqualTypeOf<{ readonly error: 'run_not_found' }>();
    expectTypeOf<SseProxyConsumerOptions['reconnectWindow']>().toEqualTypeOf<
      import('effect/Duration').DurationInput | undefined
    >();
  });
});

/* ─── Express mock ─── */

function expressRes() {
  const decoder = new TextDecoder();
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string | number>,
    body: '',
    setHeader(name: string, value: string | number) {
      res.headers[name.toLowerCase()] = value;
    },
    write(chunk: Uint8Array) {
      res.body += decoder.decode(chunk);
      return true;
    },
    end() {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: string) {
      res.body = body;
    },
  };
  return res;
}
