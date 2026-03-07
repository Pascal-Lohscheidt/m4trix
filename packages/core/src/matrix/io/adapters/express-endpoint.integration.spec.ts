import { describe, expect, test } from 'vitest';
import { Effect } from 'effect';
import { Schema as S } from 'effect';
import { AgentNetwork } from '../../agent-network/agent-network';
import { AgentNetworkEvent } from '../../agent-network/agent-network-event';
import { AgentFactory } from '../../agent-factory';
import { ExpressEndpoint } from './express-endpoint';
import type { ExpressRequest } from './express-endpoint';

type MockExpressReq = ExpressRequest & {
  body?: unknown;
  _triggerClose: () => void;
};

/** Create a mock Express-like request. `body` simulates the parsed body from express.json(). */
function mockExpressReq(opts?: { body?: unknown }): MockExpressReq {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    body: opts?.body,
    on(event: string, fn: () => void) {
      (listeners[event] ??= []).push(fn);
    },
    _triggerClose() {
      listeners['close']?.forEach((fn) => fn());
    },
  } as MockExpressReq;
}

type MockExpressRes = {
  _status: number;
  _headers: Record<string, string | number>;
  _chunks: Uint8Array[];
  _ended: boolean;
  _body: string;
  _headersFlushed: boolean;
  setHeader(name: string, value: string | number): void;
  flushHeaders(): void;
  write(chunk: Uint8Array): void;
  flush(): void;
  end(): void;
  status(code: number): MockExpressRes;
  send(body: string): void;
};

/** Create a mock Express-like response that captures writes and header state */
function mockExpressRes(): MockExpressRes {
  const decoder = new TextDecoder();

  const res: MockExpressRes = {
    _status: 200,
    _headers: {},
    _chunks: [],
    _ended: false,
    _body: '',
    _headersFlushed: false,

    setHeader(name: string, value: string | number) {
      res._headers[name.toLowerCase()] = value;
    },
    flushHeaders() {
      res._headersFlushed = true;
    },
    write(chunk: Uint8Array) {
      res._chunks.push(chunk);
      res._body += decoder.decode(chunk, { stream: true });
    },
    flush() {
      // no-op
    },
    end() {
      res._ended = true;
    },
    status(code: number) {
      res._status = code;
      return res;
    },
    send(body: string) {
      res._body = body;
      res._ended = true;
    },
  };

  return res;
}

/** Parse SSE text into an array of data payloads (JSON-parsed) */
function parseSSE(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
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
  requestToContextId: (req: ExpressRequest): string =>
    (
      req as { headers?: { get?: (n: string) => string | null } }
    ).headers?.get?.('x-correlation-id') ?? crypto.randomUUID(),
  requestToRunId: (): string => crypto.randomUUID(),
};

describe('ExpressEndpoint integration', () => {
  test('streams SSE response with correct headers from req.body', async () => {
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

      const handler = ExpressEndpoint.from(api, defaultIdOptions).handler();
      const req = mockExpressReq({ body: { message: 'hello-express' } });
      const res = mockExpressRes();

      // Schedule client disconnect after the agent has time to respond
      setTimeout(() => req._triggerClose(), 150);

      yield* Effect.tryPromise(() => Promise.resolve(handler(req, res)));

      return res;
    });

    const res = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(res._headers['content-type']).toBe('text/event-stream');
    expect(res._headers['cache-control']).toBe('no-cache');
    expect(res._headers['connection']).toBe('keep-alive');
    expect(res._headersFlushed).toBe(true);
    expect(res._ended).toBe(true);

    const events = parseSSE(res._body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'echo-response',
      payload: { reply: 'Echo: hello-express' },
    });
  });

  test('auth rejection sets status and sends error body (no SSE headers)', async () => {
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

    const handler = ExpressEndpoint.from(api, defaultIdOptions).handler();
    const req = mockExpressReq();
    const res = mockExpressRes();

    await Promise.resolve(handler(req, res));

    expect(res._status).toBe(403);
    expect(res._body).toBe('Forbidden');
    // SSE headers should NOT have been set since auth failed before consumer
    expect(res._headers['content-type']).toBeUndefined();
  });

  test('auth allowed: true proceeds with streaming', async () => {
    const { network, requestEvent } = setupEchoNetwork();

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose({
        protocol: 'sse',
        plane,
        select: { channels: 'client' },
        triggerEvents: [requestEvent],
        auth: () => ({ allowed: true }),
        onRequest: ({ emitStartEvent, req, payload }) =>
          emitStartEvent({
            contextId: req.contextId ?? crypto.randomUUID(),
            runId: req.runId ?? crypto.randomUUID(),
            event: requestEvent.make(payload as { message: string }),
          }),
      });

      const handler = ExpressEndpoint.from(api, defaultIdOptions).handler();
      const req = mockExpressReq({ body: { message: 'authed' } });
      const res = mockExpressRes();

      setTimeout(() => req._triggerClose(), 150);

      yield* Effect.tryPromise(() => Promise.resolve(handler(req, res)));
      return res;
    });

    const res = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(res._headers['content-type']).toBe('text/event-stream');
    const events = parseSSE(res._body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'echo-response',
      payload: { reply: 'Echo: authed' },
    });
  });

  test('onRequest can map payload before emitting', async () => {
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

      const handler = ExpressEndpoint.from(api, defaultIdOptions).handler();
      const req = mockExpressReq({ body: { raw: 'my-express-task' } });
      const res = mockExpressRes();

      setTimeout(() => req._triggerClose(), 150);

      yield* Effect.tryPromise(() => Promise.resolve(handler(req, res)));
      return res;
    });

    const res = await Effect.runPromise(program.pipe(Effect.scoped));

    const events = parseSSE(res._body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'task-done',
      payload: { result: 'Done: my-express-task' },
    });
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

      const handler = ExpressEndpoint.from(api, defaultIdOptions).handler();
      const req = mockExpressReq({ body: { message: 'sse-test' } });
      const res = mockExpressRes();

      setTimeout(() => req._triggerClose(), 150);

      yield* Effect.tryPromise(() => Promise.resolve(handler(req, res)));
      return res;
    });

    const res = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(res._body).toContain('event: echo-response');
    expect(res._body).toContain('data: ');
    expect(res._body).toContain('"reply":"Echo: sse-test"');
  });

  test('throws for unsupported protocol', () => {
    expect(() =>
      ExpressEndpoint.from({ protocol: 'ws' } as never, defaultIdOptions),
    ).toThrow('unsupported protocol');
  });
});
