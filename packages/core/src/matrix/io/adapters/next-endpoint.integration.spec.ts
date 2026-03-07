import { describe, expect, test } from 'vitest';
import { Effect } from 'effect';
import { Schema as S } from 'effect';
import { AgentNetwork } from '../../agent-network/agent-network';
import { AgentNetworkEvent } from '../../agent-network/agent-network-event';
import { AgentFactory } from '../../agent-factory';
import { NextEndpoint } from './next-endpoint';

/** Consume a ReadableStream<Uint8Array> collecting at most `maxEvents` SSE data payloads */
async function readSSEEvents(
  body: ReadableStream<Uint8Array>,
  maxEvents: number,
): Promise<unknown[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: unknown[] = [];

  while (events.length < maxEvents) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse complete SSE messages from buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // keep incomplete last line
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        events.push(JSON.parse(line.slice(6)));
        if (events.length >= maxEvents) break;
      }
    }
  }

  reader.cancel().catch(() => {});
  return events;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setupEchoNetwork() {
  const requestEvent = AgentNetworkEvent.of(
    'echo-request',
    S.Struct({ message: S.String }),
  );
  const responseEvent = AgentNetworkEvent.of(
    'echo-response',
    S.Struct({ reply: S.String }),
  );

  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, sink, registerAgent }) => {
      const main = mainChannel('main');
      const client = createChannel('client').sink(sink.httpStream());
      registerAgent(
        AgentFactory.run()
          .listensTo([requestEvent])
          .emits([responseEvent])
          .logic(async ({ triggerEvent, emit }) => {
            const msg = (triggerEvent.payload as { message: string }).message;
            emit({
              name: 'echo-response',
              payload: { reply: `Echo: ${msg}` },
            });
          })
          .produce({}),
      )
        .subscribe(main)
        .publishTo(client);
    },
  );
  return { network, requestEvent };
}

const defaultIdOptions = {
  requestToContextId: (r: Request): string =>
    r.headers.get('x-correlation-id') ?? crypto.randomUUID(),
  requestToRunId: (): string => crypto.randomUUID(),
};

describe('NextEndpoint integration', () => {
  test('POST handler streams SSE response with correct headers', async () => {
    const { network, requestEvent } = setupEchoNetwork();

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose({
        protocol: 'sse',
        plane,
        select: { channels: 'client' },
        triggerEvents: [requestEvent],
        onRequest: ({ emitStartEvent, req, payload }) =>
          emitStartEvent({
            contextId: req.contextId ?? crypto.randomUUID(),
            runId: req.runId ?? crypto.randomUUID(),
            event: requestEvent.make(payload as { message: string }),
          }),
      });

      const handler = NextEndpoint.from(api, defaultIdOptions).handler();
      const request = new Request('http://test/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });

      const response = yield* Effect.tryPromise(() => handler(request));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');

      const events = yield* Effect.tryPromise(() =>
        readSSEEvents(response.body!, 1),
      );

      return events;
    });

    const events = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'echo-response',
      payload: { reply: 'Echo: hello' },
    });
  });

  test('GET handler with query-param mapping via onRequest', async () => {
    const { network, requestEvent } = setupEchoNetwork();

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose({
        protocol: 'sse',
        plane,
        select: { channels: 'client' },
        triggerEvents: [requestEvent],
        onRequest: ({ emitStartEvent, req }) => {
          const url = req.request?.url;
          if (url) {
            const msg = new URL(url).searchParams.get('message') ?? '';
            emitStartEvent({
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: requestEvent.make({ message: msg }),
            });
          }
        },
      });

      const handler = NextEndpoint.from(api, defaultIdOptions).handler();
      const request = new Request('http://test/api?message=from-get', {
        method: 'GET',
      });

      const response = yield* Effect.tryPromise(() => handler(request));
      expect(response.status).toBe(200);

      const events = yield* Effect.tryPromise(() =>
        readSSEEvents(response.body!, 1),
      );
      return events;
    });

    const events = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'echo-response',
      payload: { reply: 'Echo: from-get' },
    });
  });

  test('auth rejection returns error Response with correct status', async () => {
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, sink }) => {
        mainChannel('main');
        createChannel('client').sink(sink.httpStream());
      },
    );

    const api = network.expose({
      protocol: 'sse',
      select: { channels: 'client' },
      auth: () => ({ allowed: false, status: 401, message: 'Unauthorized' }),
    });

    const handler = NextEndpoint.from(api, defaultIdOptions).handler();
    const request = new Request('http://test/api', { method: 'POST' });
    const response = await handler(request);

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe('Unauthorized');
  });

  test('auth with 403 Forbidden', async () => {
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, sink }) => {
        mainChannel('main');
        createChannel('client').sink(sink.httpStream());
      },
    );

    const api = network.expose({
      protocol: 'sse',
      select: { channels: 'client' },
      auth: () => ({ allowed: false, status: 403, message: 'Forbidden' }),
    });

    const handler = NextEndpoint.from(api, defaultIdOptions).handler();
    const request = new Request('http://test/api', { method: 'POST' });
    const response = await handler(request);

    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toBe('Forbidden');
  });

  test('SSE format uses event: and data: lines', async () => {
    const { network, requestEvent } = setupEchoNetwork();

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose({
        protocol: 'sse',
        plane,
        select: { channels: 'client' },
        triggerEvents: [requestEvent],
        onRequest: ({ emitStartEvent, req, payload }) =>
          emitStartEvent({
            contextId: req.contextId ?? crypto.randomUUID(),
            runId: req.runId ?? crypto.randomUUID(),
            event: requestEvent.make(payload as { message: string }),
          }),
      });

      const handler = NextEndpoint.from(api, defaultIdOptions).handler();
      const request = new Request('http://test/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test' }),
      });

      const response = yield* Effect.tryPromise(() => handler(request));
      const events = yield* Effect.tryPromise(() =>
        readSSEEvents(response.body!, 1),
      );
      // Re-read raw text by reconstructing from events
      return events;
    });

    const events = await Effect.runPromise(program.pipe(Effect.scoped));

    // Verify events were parsed (formatSSE produces event: and data: lines)
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'echo-response',
      payload: { reply: 'Echo: test' },
    });
  });

  test('onRequest payload mapping flows through NextEndpoint', async () => {
    const requestEvent = AgentNetworkEvent.of(
      'task',
      S.Struct({ task: S.String }),
    );
    const resultEvent = AgentNetworkEvent.of(
      'task-done',
      S.Struct({ result: S.String }),
    );

    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, sink, registerAgent }) => {
        const main = mainChannel('main');
        const client = createChannel('client').sink(sink.httpStream());
        registerAgent(
          AgentFactory.run()
            .listensTo([requestEvent])
            .emits([resultEvent])
            .logic(async ({ triggerEvent, emit }) => {
              const task = (triggerEvent.payload as { task: string }).task;
              emit({
                name: 'task-done',
                payload: { result: `Done: ${task}` },
              });
            })
            .produce({}),
        )
          .subscribe(main)
          .publishTo(client);
      },
    );

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose({
        protocol: 'sse',
        plane,
        select: { channels: 'client' },
        triggerEvents: [requestEvent],
        onRequest: ({ emitStartEvent, req, payload }) => {
          const body = payload as { raw?: string };
          emitStartEvent({
            contextId: req.contextId ?? crypto.randomUUID(),
            runId: req.runId ?? crypto.randomUUID(),
            event: requestEvent.make({ task: body.raw ?? 'default' }),
          });
        },
      });

      const handler = NextEndpoint.from(api, defaultIdOptions).handler();
      const request = new Request('http://test/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: 'my-task' }),
      });

      const response = yield* Effect.tryPromise(() => handler(request));
      const events = yield* Effect.tryPromise(() =>
        readSSEEvents(response.body!, 1),
      );
      return events;
    });

    const events = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'task-done',
      payload: { result: 'Done: my-task' },
    });
  });

  test('requestToContextId and requestToRunId map request to IDs', async () => {
    const requestEvent = AgentNetworkEvent.of(
      'request',
      S.Struct({ x: S.Number }),
    );
    const responseEvent = AgentNetworkEvent.of(
      'response',
      S.Struct({
        meta: S.Struct({ runId: S.String, contextId: S.String }),
      }),
    );

    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, sink, registerAgent }) => {
        const main = mainChannel('main');
        const client = createChannel('client').sink(sink.httpStream());
        registerAgent(
          AgentFactory.run()
            .listensTo([requestEvent])
            .emits([responseEvent])
            .logic(async ({ triggerEvent, emit }) => {
              emit({
                name: 'response',
                payload: {
                  meta: {
                    runId: triggerEvent.meta.runId,
                    contextId: triggerEvent.meta.contextId,
                  },
                },
              });
            })
            .produce({}),
        )
          .subscribe(main)
          .publishTo(client);
      },
    );

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose({
        protocol: 'sse',
        plane,
        select: { channels: 'client' },
        onRequest: ({ emitStartEvent, req, payload }) =>
          emitStartEvent({
            contextId: req.contextId!,
            runId: req.runId!,
            event: requestEvent.make(payload as { x: number }),
          }),
      });

      const handler = NextEndpoint.from(api, {
        requestToContextId: (r) =>
          r.headers.get('x-correlation-id') ?? 'fallback-context',
        requestToRunId: () => 'custom-run-id',
      }).handler();

      const request = new Request('http://test/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': 'my-correlation-id',
        },
        body: JSON.stringify({ x: 1 }),
      });

      const response = yield* Effect.tryPromise(() => handler(request));
      const events = yield* Effect.tryPromise(() =>
        readSSEEvents(response.body!, 1),
      );
      return events;
    });

    const events = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'response',
      payload: {
        meta: {
          runId: 'custom-run-id',
          contextId: 'my-correlation-id',
        },
      },
    });
  });

  test('throws for unsupported protocol', () => {
    expect(() =>
      NextEndpoint.from({ protocol: 'ws' } as never, defaultIdOptions),
    ).toThrow('unsupported protocol');
  });
});
