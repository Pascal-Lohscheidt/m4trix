import { Schema as S } from 'effect';
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from '../../agent-factory.js';
import { AgentNetwork } from '../../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../../agent-network/agent-network-event.js';
import type { Envelope } from '../../agent-network/event-plane.js';
import { RunLifecycleEvent } from '../../agent-network/run-lifecycle.js';
import type { NetworkLogger } from '../../logger.js';
import { registerSSEStream } from '../proxy-consumer.js';
import type { ExposedAPI, ExposedStream } from '../types.js';
import {
  ExpressEndpoint,
  type ExpressEndpointOptions,
  type ExpressRequest,
  type ExpressResponse,
} from './express-endpoint.js';
import { NextEndpoint, type NextEndpointOptions } from './next-endpoint.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));

const ids = { requestToContextId: () => 'ctx', requestToRunId: () => 'run' };

/** start -> answer once `release` is called. */
function slowNetwork() {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
      const client = createChannel('client').proxy(proxy.sse());
      registerAgent(
        AgentFactory.run()
          .listensTo([start])
          .emits([answer])
          .logic(async ({ emit }) => {
            await released;
            emit(answer.make({ text: 'done' }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client);
      endsOn(answer);
    },
  );
  const api = network.expose(registerSSEStream({ triggerEvents: [start], idleTimeout: Infinity }));
  return { api, release };
}

/** An API whose stream yields `before` and then throws. */
function failingApi(before: Envelope[]): ExposedAPI {
  return {
    protocol: 'sse',
    createStream: (async (
      _req: unknown,
      consumer?: (stream: ExposedStream) => Promise<unknown>,
    ) => {
      const stream: ExposedStream = {
        async *[Symbol.asyncIterator]() {
          yield* before;
          throw new Error('queue exploded');
        },
      };
      return consumer ? consumer(stream) : stream;
    }) as ExposedAPI['createStream'],
  };
}

const answerEnvelope: Envelope = {
  name: 'answer',
  meta: { runId: 'run', contextId: 'ctx', eventId: 'e1' },
  payload: { text: 'partial' },
};

const recordingLogger = () => ({
  warn: vi.fn<(message: string, data?: unknown) => void>(),
  error: vi.fn<(message: string, data?: unknown) => void>(),
});

const post = () =>
  new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

/** Reads a response body as it arrives. */
function bodyReader(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let done = false;
  const finished = (async () => {
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    done = true;
  })();
  return { text: () => text, done: () => done, finished };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ─── Express mocks ─── */

type MockRes = ExpressResponse & {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  writes: string[];
  ended: boolean;
  headersSent: boolean;
  emit(event: 'drain' | 'close'): void;
  /** Make the next `write` calls return false (buffer full). */
  full: boolean;
};

function expressRes(): MockRes {
  const decoder = new TextDecoder();
  const listeners: Record<string, Array<() => void>> = {};
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: '',
    writes: [],
    ended: false,
    headersSent: false,
    full: false,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    flushHeaders() {
      res.headersSent = true;
    },
    write(chunk) {
      res.headersSent = true;
      const text = decoder.decode(chunk);
      res.writes.push(text);
      res.body += text;
      return !res.full;
    },
    end() {
      res.ended = true;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    send(body) {
      res.body = body;
      res.ended = true;
    },
    once(event, fn) {
      const list = listeners[event] ?? [];
      list.push(fn);
      listeners[event] = list;
      return res;
    },
    emit(event) {
      const fns = listeners[event] ?? [];
      listeners[event] = [];
      for (const fn of fns) fn();
    },
  };
  return res;
}

const expressReq = (): ExpressRequest =>
  ({ method: 'POST', headers: {}, body: {}, on: () => {} }) as ExpressRequest;

describe('SSE adapters hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('NextEndpoint', () => {
    test('sends X-Accel-Buffering: no', async () => {
      const { api, release } = slowNetwork();
      release();

      const response = await NextEndpoint.from(api, ids).handler()(post());
      await response.text();

      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    });

    test('writes a heartbeat comment every 15 seconds by default', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { api, release } = slowNetwork();
      const body = bodyReader(await NextEndpoint.from(api, ids).handler()(post()));
      await flush();

      vi.advanceTimersByTime(14_999);
      await flush();
      expect(body.text()).not.toContain(': ping');
      vi.advanceTimersByTime(1);
      await flush();
      expect(body.text()).toContain(': ping\n\n');

      release();
      await body.finished;
      expect(body.text()).toContain(`event: ${RunLifecycleEvent.completed}`);
    });

    test('the heartbeat is configurable; Infinity disables it', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const fast = slowNetwork();
      const off = slowNetwork();
      const fastBody = bodyReader(
        await NextEndpoint.from(fast.api, { ...ids, heartbeat: '1 second' }).handler()(post()),
      );
      const offBody = bodyReader(
        await NextEndpoint.from(off.api, { ...ids, heartbeat: Infinity }).handler()(post()),
      );
      await flush();

      vi.advanceTimersByTime(60_000);
      await flush();

      expect(fastBody.text()).toContain(': ping');
      expect(offBody.text()).not.toContain(': ping');
      fast.release();
      off.release();
      await Promise.all([fastBody.finished, offBody.finished]);
    });

    test('a failure after the response started ends the stream cleanly with run.failed, logged', async () => {
      const logger = recordingLogger();

      const response = await NextEndpoint.from(failingApi([answerEnvelope]), {
        ...ids,
        logger,
      }).handler()(post());
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: answer');
      const failed = text
        .split('\n\n')
        .find((m) => m.includes(`event: ${RunLifecycleEvent.failed}`));
      expect(failed).toBeDefined();
      expect(JSON.parse(failed?.split('data: ')[1] ?? '')).toEqual({
        name: RunLifecycleEvent.failed,
        meta: { runId: 'run', contextId: 'ctx' },
        payload: {
          error: { name: 'StreamError', message: 'The event stream failed', kind: 'stream-error' },
        },
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('SSE stream failed'),
        expect.objectContaining({ message: 'queue exploded' }),
      );
    });
  });

  describe('ExpressEndpoint', () => {
    test('sends X-Accel-Buffering: no', async () => {
      const { api, release } = slowNetwork();
      release();
      const res = expressRes();

      await ExpressEndpoint.from(api, ids).handler()(expressReq(), res);

      expect(res.headers['x-accel-buffering']).toBe('no');
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    test('writes a heartbeat comment every 15 seconds by default; configurable', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const byDefault = slowNetwork();
      const off = slowNetwork();
      const res = expressRes();
      const offRes = expressRes();
      const done = ExpressEndpoint.from(byDefault.api, ids).handler()(expressReq(), res);
      const offDone = ExpressEndpoint.from(off.api, { ...ids, heartbeat: Infinity }).handler()(
        expressReq(),
        offRes,
      );
      await flush();

      vi.advanceTimersByTime(15_000);
      await flush();

      expect(res.writes).toContain(': ping\n\n');
      expect(offRes.writes).not.toContain(': ping\n\n');
      byDefault.release();
      off.release();
      await Promise.all([done, offDone]);
    });

    test("respects back-pressure: waits for 'drain' when write returns false", async () => {
      const { api, release } = slowNetwork();
      const res = expressRes();
      res.full = true;
      const done = ExpressEndpoint.from(api, { ...ids, heartbeat: Infinity }).handler()(
        expressReq(),
        res,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The start id was written and refused (buffer full): nothing more until drain.
      expect(res.writes).toHaveLength(1);
      expect(res.ended).toBe(false);

      res.full = false;
      res.emit('drain');
      await done;

      expect(res.body).toContain('event: answer');
      expect(res.body).toContain(`event: ${RunLifecycleEvent.completed}`);
      expect(res.ended).toBe(true);
    });

    test('an error after the headers were sent ends the stream with run.failed and never rejects', async () => {
      const logger = recordingLogger();
      const res = expressRes();
      const next = vi.fn();

      await expect(
        ExpressEndpoint.from(failingApi([answerEnvelope]), { ...ids, logger }).handler()(
          expressReq(),
          res,
          next,
        ),
      ).resolves.toBeUndefined();

      expect(res.body).toContain('event: answer');
      expect(res.body).toContain(`event: ${RunLifecycleEvent.failed}`);
      expect(res.body).toContain('"kind":"stream-error"');
      expect(res.ended).toBe(true);
      expect(next).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('SSE stream failed'),
        expect.objectContaining({ message: 'queue exploded' }),
      );
    });

    test('an error before the headers goes to next(), or becomes a 500 without it; never a rejection', async () => {
      const broken: ExposedAPI = {
        protocol: 'sse',
        createStream: (async () => {
          throw new Error('boom before headers');
        }) as ExposedAPI['createStream'],
      };
      const logger = recordingLogger();
      const next = vi.fn();
      const withNext = expressRes();
      const withoutNext = expressRes();

      await ExpressEndpoint.from(broken, { ...ids, logger }).handler()(
        expressReq(),
        withNext,
        next,
      );
      await expect(
        ExpressEndpoint.from(broken, { ...ids, logger }).handler()(expressReq(), withoutNext),
      ).resolves.toBeUndefined();

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'boom before headers' }),
      );
      expect(withoutNext.statusCode).toBe(500);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  test('types', () => {
    expectTypeOf<NextEndpointOptions['heartbeat']>().toEqualTypeOf<
      import('effect/Duration').DurationInput | undefined
    >();
    expectTypeOf<ExpressEndpointOptions['heartbeat']>().toEqualTypeOf<
      import('effect/Duration').DurationInput | undefined
    >();
    expectTypeOf<NextEndpointOptions['logger']>().toEqualTypeOf<NetworkLogger | undefined>();
    expectTypeOf<ExpressEndpointOptions['logger']>().toEqualTypeOf<NetworkLogger | undefined>();
  });
});
