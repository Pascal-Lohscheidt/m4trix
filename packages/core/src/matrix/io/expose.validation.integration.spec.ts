import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import type { Envelope } from '../agent-network/event-plane.js';
import type { AgentNetworkStore } from '../agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import type { NetworkTracer } from '../tracing/network-tracer.js';
import { noopRunTraceScope } from '../tracing/network-tracer.js';
import type { ValidationIssue } from '../validation.js';
import { ExpressEndpoint, type ExpressRequest } from './adapters/express-endpoint.js';
import { NextEndpoint } from './adapters/next-endpoint.js';
import { ExposeValidationError, type ExposeValidationErrorBody } from './expose.js';
import { registerSSEStream, type SseProxyConsumerOptions } from './proxy-consumer.js';
import type { AuthResult, ExposedStream } from './types.js';

const ask = AgentNetworkEvent.of('ask', S.Struct({ question: S.Trim, limit: S.NumberFromString }));
const other = AgentNetworkEvent.of('other', S.Struct({ n: S.Number }));
const reply = AgentNetworkEvent.of('reply', S.Struct({ text: S.String }));

const ids = {
  requestToContextId: (): string => crypto.randomUUID(),
  requestToRunId: (): string => crypto.randomUUID(),
};

/** A network whose single agent records its triggers; tracer hooks and store appends recorded. */
function fixture(options: Omit<SseProxyConsumerOptions, 'channel'> = {}) {
  const triggers: Envelope[] = [];
  const tracerCalls: string[] = [];
  const appends: string[] = [];
  const inner = createInMemoryNetworkStore();
  const store: AgentNetworkStore = {
    append: (key, event) => {
      appends.push(event.name);
      return inner.append(key, event);
    },
    readRun: (key, runId) => inner.readRun(key, runId),
    readContext: (key, opts) => inner.readContext(key, opts),
  };
  const networkTracer: NetworkTracer = {
    onRunStart: async () => {
      tracerCalls.push('onRunStart');
    },
    onRunEnd: async () => {
      tracerCalls.push('onRunEnd');
    },
    onEventPublish: async () => {
      tracerCalls.push('onEventPublish');
    },
    onAgentInvokeStart: async ({ trigger }) => {
      tracerCalls.push('onAgentInvokeStart');
      return noopRunTraceScope(trigger.meta);
    },
    onAgentInvokeEnd: async () => {
      tracerCalls.push('onAgentInvokeEnd');
    },
    flush: async () => {},
  };
  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
      const client = createChannel('client').proxy(proxy.sse());
      registerAgent(
        AgentFactory.run()
          .listensTo([ask, other])
          .emits([reply])
          .logic(async ({ triggerEvent, emit }) => {
            triggers.push(triggerEvent);
            emit(reply.make({ text: 'ok' }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client);
      endsOn(reply);
    },
    { networkTracer, store },
  );
  const api = network.expose(registerSSEStream({ triggerEvents: [ask], ...options }));
  return { api, triggers, tracerCalls, appends };
}

const post = (body: string, headers: Record<string, string> = {}): Request =>
  new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

/* ─── Express mocks ─── */

type MockRes = {
  status_: number;
  headers: Record<string, string | number>;
  body: string;
  setHeader(name: string, value: string | number): void;
  write(chunk: Uint8Array): void;
  end(): void;
  status(code: number): MockRes;
  send(body: string): void;
};

function expressReq(body: unknown, headers: Record<string, string> = {}): ExpressRequest {
  return { body, headers, on: () => {} } as ExpressRequest;
}

function expressRes(): MockRes {
  const decoder = new TextDecoder();
  const res: MockRes = {
    status_: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    write(chunk) {
      res.body += decoder.decode(chunk);
    },
    end() {},
    status(code) {
      res.status_ = code;
      return res;
    },
    send(body) {
      res.body = body;
    },
  };
  return res;
}

describe('inbound payload validation', () => {
  describe('NextEndpoint', () => {
    test('a payload that fails the trigger schema is a 400 with structured issues; nothing runs', async () => {
      const { api, triggers, tracerCalls, appends } = fixture();
      const handler = NextEndpoint.from(api, ids).handler();

      const response = await handler(post(JSON.stringify({ question: 42 })));

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        issues: [
          { path: 'question', message: expect.any(String) },
          { path: 'limit', message: expect.any(String) },
        ],
      });
      expect(triggers).toEqual([]);
      expect(tracerCalls).toEqual([]);
      expect(appends).toEqual([]);
    });

    test('malformed JSON is a 400, not an empty payload', async () => {
      const { api, triggers, tracerCalls, appends } = fixture();
      const handler = NextEndpoint.from(api, ids).handler();

      const response = await handler(post('{"question": "hi",'));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        issues: [{ path: '', message: 'Request body is not valid JSON' }],
      });
      expect(triggers).toEqual([]);
      expect(tracerCalls).toEqual([]);
      expect(appends).toEqual([]);
    });

    test('auth runs first: a denied request is a 401 whatever its payload', async () => {
      const auth = vi.fn((): AuthResult => ({ allowed: false, status: 401, message: 'Nope' }));
      const { api } = fixture({ auth });
      const handler = NextEndpoint.from(api, ids).handler();

      const response = await handler(post('not json at all'));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Nope');
      expect(auth).toHaveBeenCalledTimes(1);
    });

    test('an allowed request is validated after auth', async () => {
      const auth = vi.fn((): AuthResult => ({ allowed: true }));
      const { api } = fixture({ auth });
      const handler = NextEndpoint.from(api, ids).handler();

      const response = await handler(post(JSON.stringify({})));

      expect(auth).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(400);
    });

    test('a valid payload starts the run with the decoded values', async () => {
      const { api, triggers } = fixture();
      const handler = NextEndpoint.from(api, ids).handler();

      const response = await handler(post(JSON.stringify({ question: '  why?  ', limit: '3' })));
      await response.text();

      expect(response.status).toBe(200);
      expect(triggers.map((t) => [t.name, t.payload])).toEqual([
        ['ask', { question: 'why?', limit: 3 }],
      ]);
    });
  });

  describe('ExpressEndpoint', () => {
    test('a payload that fails the trigger schema is a 400 with a JSON body', async () => {
      const { api, triggers, tracerCalls } = fixture();
      const res = expressRes();

      await ExpressEndpoint.from(api, ids).handler()(expressReq({ question: 'q' }), res);

      expect(res.status_).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(JSON.parse(res.body)).toEqual({
        error: 'invalid_request',
        issues: [{ path: 'limit', message: expect.any(String) }],
      });
      expect(triggers).toEqual([]);
      expect(tracerCalls).toEqual([]);
    });

    test('a malformed JSON body (raw or text body parser) is a 400', async () => {
      const { api, triggers } = fixture();
      const res = expressRes();

      await ExpressEndpoint.from(api, ids).handler()(
        expressReq('{"question":', { 'content-type': 'application/json' }),
        res,
      );

      expect(res.status_).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: 'invalid_request',
        issues: [{ path: '', message: 'Request body is not valid JSON' }],
      });
      expect(triggers).toEqual([]);
    });

    test('a JSON string body is parsed and validated', async () => {
      const { api, triggers } = fixture();
      const res = expressRes();

      await ExpressEndpoint.from(api, ids).handler()(
        expressReq(JSON.stringify({ question: 'q', limit: '1' }), {
          'content-type': 'application/json; charset=utf-8',
        }),
        res,
      );

      expect(res.status_).toBe(200);
      expect(triggers.map((t) => t.payload)).toEqual([{ question: 'q', limit: 1 }]);
    });

    test('auth runs first: a denied request is a 401', async () => {
      const { api } = fixture({ auth: () => ({ allowed: false, status: 401 }) });
      const res = expressRes();

      await ExpressEndpoint.from(api, ids).handler()(expressReq({ bad: true }), res);

      expect(res.status_).toBe(401);
      expect(res.body).toBe('Unauthorized');
    });
  });

  describe('several trigger events', () => {
    const several = () => fixture({ triggerEvents: [ask, other] });

    test('the body names the trigger event: { name, payload }', async () => {
      const { api, triggers } = several();

      await api.createStream(
        { request: post(JSON.stringify({ name: 'other', payload: { n: 1 } })) },
        collect,
      );

      expect(triggers.map((t) => [t.name, t.payload])).toEqual([['other', { n: 1 }]]);
    });

    test('a body without a known name is a 400 naming the choices', async () => {
      const { api, triggers } = several();

      const error = await api
        .createStream({ request: post(JSON.stringify({ question: 'q', limit: '1' })) })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExposeValidationError);
      expect((error as ExposeValidationError).issues).toEqual([
        { path: 'name', message: 'Expected one of "ask", "other"' },
      ]);
      expect(triggers).toEqual([]);
    });

    test("payload issues are located under 'payload'", async () => {
      const { api } = several();

      const error = await api
        .createStream({ request: post(JSON.stringify({ name: 'other', payload: { n: 'x' } })) })
        .catch((e: unknown) => e);

      expect((error as ExposeValidationError).issues).toEqual([
        { path: 'payload.n', message: expect.any(String) },
      ]);
    });
  });

  describe('GET ?payload= (EventSource)', () => {
    const get = (payload?: string): Request =>
      new Request(
        payload === undefined
          ? 'http://test/api'
          : `http://test/api?payload=${encodeURIComponent(payload)}`,
      );

    test('a valid payload starts the run with the decoded values', async () => {
      const { api, triggers } = fixture();

      const events = await api.createStream(
        { request: get(JSON.stringify({ question: ' q ', limit: '2' })) },
        collect,
      );

      expect(events.map((e) => e.name)).toEqual(['reply', 'm4trix:run.completed']);
      expect(triggers.map((t) => t.payload)).toEqual([{ question: 'q', limit: 2 }]);
    });

    test('with several trigger events it names the event: { name, payload }', async () => {
      const { api, triggers } = fixture({ triggerEvents: [ask, other] });

      await api.createStream(
        { request: get(JSON.stringify({ name: 'other', payload: { n: 3 } })) },
        collect,
      );

      expect(triggers.map((t) => [t.name, t.payload])).toEqual([['other', { n: 3 }]]);
    });

    test('malformed JSON is a 400; nothing runs', async () => {
      const { api, triggers, tracerCalls } = fixture();

      const error = await api.createStream({ request: get('{"question":') }).catch((e) => e);

      expect(error).toBeInstanceOf(ExposeValidationError);
      expect((error as ExposeValidationError).issues).toEqual([
        { path: '', message: 'The payload query parameter is not valid JSON' },
      ]);
      expect(triggers).toEqual([]);
      expect(tracerCalls).toEqual([]);
    });

    test('a schema-invalid payload is a 400 through NextEndpoint', async () => {
      const { api, triggers } = fixture();

      const response = await NextEndpoint.from(api, ids).handler()(
        get(JSON.stringify({ question: 'q' })),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        issues: [{ path: 'limit', message: expect.any(String) }],
      });
      expect(triggers).toEqual([]);
    });

    test('ExpressEndpoint reads it from req.query, or from the URL', async () => {
      const fromQuery = fixture();
      const res = expressRes();
      await ExpressEndpoint.from(fromQuery.api, ids).handler()(
        {
          method: 'GET',
          query: { payload: JSON.stringify({ question: 'a', limit: '1' }) },
          headers: {},
          on: () => {},
        } as ExpressRequest,
        res,
      );
      expect(res.status_).toBe(200);
      expect(fromQuery.triggers.map((t) => t.payload)).toEqual([{ question: 'a', limit: 1 }]);

      const fromUrl = fixture();
      const invalid = expressRes();
      await ExpressEndpoint.from(fromUrl.api, ids).handler()(
        {
          method: 'GET',
          originalUrl: `/api?payload=${encodeURIComponent('not json')}`,
          headers: {},
          on: () => {},
        } as ExpressRequest,
        invalid,
      );
      expect(invalid.status_).toBe(400);
      expect(JSON.parse(invalid.body).issues).toEqual([
        { path: '', message: 'The payload query parameter is not valid JSON' },
      ]);
      expect(fromUrl.triggers).toEqual([]);
    });

    test('a GET without ?payload= has the empty payload', async () => {
      const { api } = fixture();

      const error = await api.createStream({ request: get() }).catch((e) => e);

      // `{}` is checked like any body: the trigger needs question and limit.
      expect((error as ExposeValidationError).issues.map((i) => i.path).sort()).toEqual([
        'limit',
        'question',
      ]);
    });
  });

  describe('onRequest + emitStartEvent', () => {
    test('a start event that fails its trigger schema is a 400; no run starts', async () => {
      const { api, triggers, tracerCalls, appends } = fixture({
        onRequest: ({ emitStartEvent }) => {
          emitStartEvent({
            runId: 'run-1',
            contextId: 'ctx-1',
            event: { name: 'ask', payload: { question: 7 } },
          });
        },
      });
      const handler = NextEndpoint.from(api, ids).handler();

      const response = await handler(new Request('http://test/api'));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'invalid_request',
        issues: expect.arrayContaining([{ path: 'question', message: expect.any(String) }]),
      });
      expect(triggers).toEqual([]);
      expect(tracerCalls).toEqual([]);
      expect(appends).toEqual([]);
    });

    test('events the network listens to are validated too, not only triggerEvents', async () => {
      const { api, triggers } = fixture({
        onRequest: ({ emitStartEvent }) => {
          emitStartEvent({
            runId: 'run-1',
            contextId: 'ctx-1',
            event: { name: 'other', payload: { n: 'one' } },
          });
        },
      });

      const error = await api
        .createStream({ request: new Request('http://test/api') })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExposeValidationError);
      expect((error as ExposeValidationError).issues).toEqual([
        { path: 'n', message: expect.any(String) },
      ]);
      expect(triggers).toEqual([]);
    });

    test('a start event from make() is accepted and published decoded', async () => {
      const { api, triggers } = fixture({
        onRequest: ({ emitStartEvent }) => {
          emitStartEvent({
            runId: 'run-1',
            contextId: 'ctx-1',
            event: ask.make({ question: ' hi ', limit: '2' }),
          });
        },
      });

      await api.createStream({ request: new Request('http://test/api') }, collect);

      expect(triggers.map((t) => t.payload)).toEqual([{ question: 'hi', limit: 2 }]);
    });

    test('malformed JSON is a 400 before onRequest runs', async () => {
      const onRequest = vi.fn();
      const { api } = fixture({ onRequest });

      const error = await api.createStream({ request: post('{') }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExposeValidationError);
      expect(onRequest).not.toHaveBeenCalled();
    });
  });

  test('custom proxies get the typed error from createStream', async () => {
    const { api } = fixture();

    const error = await api
      .createStream({ request: post(JSON.stringify({ question: 'q' })) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExposeValidationError);
    const validation = error as ExposeValidationError;
    expect(validation.status).toBe(400);
    expect(validation.toJSON()).toEqual({ error: 'invalid_request', issues: validation.issues });
    expect(JSON.stringify(validation)).toBe(JSON.stringify(validation.toJSON()));
  });

  test('expose() fails when the main channel does not accept a trigger event', () => {
    const network = AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent }) => {
      mainChannel.events([other]);
      const client = createChannel('client').proxy(proxy.sse());
      registerAgent(
        AgentFactory.run()
          .listensTo([other])
          .emits([reply])
          .logic(async () => {})
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client);
    });

    expect(() => network.expose(registerSSEStream({ triggerEvents: [ask] }))).toThrow(
      /trigger event "ask".*"main"/,
    );
  });

  test('types', () => {
    expectTypeOf<ExposeValidationError['status']>().toEqualTypeOf<400>();
    expectTypeOf<ExposeValidationError['issues']>().toEqualTypeOf<ReadonlyArray<ValidationIssue>>();
    expectTypeOf<
      ReturnType<ExposeValidationError['toJSON']>
    >().toEqualTypeOf<ExposeValidationErrorBody>();
    expectTypeOf<ExposeValidationErrorBody>().toEqualTypeOf<{
      readonly error: 'invalid_request';
      readonly issues: ReadonlyArray<ValidationIssue>;
    }>();
  });
});
