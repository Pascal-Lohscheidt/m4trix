import { describe, expect, test } from 'vitest';
import { Effect } from 'effect';
import { Schema as S } from 'effect';
import { AgentNetwork } from '../agent-network/agent-network';
import { AgentNetworkEvent } from '../agent-network/agent-network-event';
import { AgentFactory } from '../agent-factory';
import { ExposeAuthError } from './expose';

async function takeFirst(stream: AsyncIterable<unknown>): Promise<unknown> {
  for await (const e of stream) return e;
  return undefined;
}

async function takeN(
  stream: AsyncIterable<unknown>,
  n: number,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of stream) {
    out.push(e);
    if (out.length >= n) return out;
  }
  return out;
}

/** Create a mock POST Request with JSON body */
function mockPostRequest(payload: unknown): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: new AbortController().signal,
  });
}

/** Create a mock GET Request (no body) */
function mockGetRequest(url = 'http://test/api'): Request {
  return new Request(url, {
    method: 'GET',
    signal: new AbortController().signal,
  });
}

/** Take first event or undefined when the stream ends/aborts without yielding */
async function takeFirstOrTimeout(
  stream: AsyncIterable<unknown>,
): Promise<unknown> {
  try {
    for await (const e of stream) return e;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
  return undefined;
}

describe('expose integration', () => {
  describe('emitStartEvent default (pass-through)', () => {
    test('POST with JSON body triggers agent and streams response', async () => {
      const requestEvent = AgentNetworkEvent.of(
        'reasoning-request',
        S.Struct({ request: S.String }),
      );
      const responseEvent = AgentNetworkEvent.of(
        'reasoning-response',
        S.Struct({ response: S.String }),
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
                const req = (triggerEvent.payload as { request: string })
                  .request;
                emit({
                  name: 'reasoning-response',
                  payload: { response: `Echo: ${req}` },
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
          onRequest: ({ emitStartEvent, req, payload }) =>
            emitStartEvent({
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: requestEvent.make(payload as { request: string }),
            }),
        });

        const req = mockPostRequest({ request: 'What is 2+2?' });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'reasoning-response',
        payload: { response: 'Echo: What is 2+2?' },
      });
    });

    test('uses default triggerEvents ["request"] when not specified', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ foo: S.String }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ ok: S.Boolean }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
              .logic(async ({ emit }) => {
                emit({
                  name: 'response',
                  payload: { ok: true },
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
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: requestEvt.make(payload as { foo: string }),
            }),
        });

        const req = mockPostRequest({ foo: 'bar' });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'response',
        payload: { ok: true },
      });
    });

    test('default path (no plane, no onRequest) triggers agent via auto-publish', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'reasoning-request',
        S.Struct({ request: S.String }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'reasoning-response',
        S.Struct({ response: S.String }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
              .logic(async ({ triggerEvent, emit }) => {
                const req = (triggerEvent.payload as { request: string })
                  .request;
                emit({
                  name: 'reasoning-response',
                  payload: { response: `Echo: ${req}` },
                });
              })
              .produce({}),
          )
            .subscribe(main)
            .publishTo(client);
        },
      );

      const api = network.expose({
        protocol: 'sse',
        select: { channels: 'client' },
        triggerEvents: [requestEvt],
      });

      const req = mockPostRequest({ request: 'What is 2+2?' });
      const received = await api.createStream({ request: req }, (stream) =>
        takeFirst(stream),
      );

      expect(received).toMatchObject({
        name: 'reasoning-response',
        payload: { response: 'Echo: What is 2+2?' },
      });
    });
  });

  describe('onRequest override', () => {
    test('onRequest can map payload before emitting', async () => {
      const requestEvent = AgentNetworkEvent.of(
        'task-request',
        S.Struct({ task: S.String }),
      );
      const taskDoneEvent = AgentNetworkEvent.of(
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
              .emits([taskDoneEvent])
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

        const req = mockPostRequest({ raw: 'custom-task' });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'task-done',
        payload: { result: 'Done: custom-task' },
      });
    });

    test('onRequest can map from query params (GET)', async () => {
      const requestEvent = AgentNetworkEvent.of(
        'query-request',
        S.Struct({ q: S.String }),
      );
      const queryResultEvent = AgentNetworkEvent.of(
        'query-result',
        S.Struct({ answer: S.String }),
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvent])
              .emits([queryResultEvent])
              .logic(async ({ triggerEvent, emit }) => {
                const q = (triggerEvent.payload as { q: string }).q;
                emit({
                  name: 'query-result',
                  payload: { answer: q },
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
          onRequest: ({ emitStartEvent, req }) => {
            const url = req.request?.url;
            if (url) {
              const q = new URL(url).searchParams.get('q') ?? '';
              emitStartEvent({
                contextId: req.contextId ?? crypto.randomUUID(),
                runId: req.runId ?? crypto.randomUUID(),
                event: requestEvent.make({ q }),
              });
            }
          },
        });

        const req = mockGetRequest('http://test/api?q=hello');
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'query-result',
        payload: { answer: 'hello' },
      });
    });

    test('onRequest can skip emitting', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ request: S.String }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ ok: S.Boolean }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
              .logic(async ({ emit }) => {
                emit({
                  name: 'response',
                  payload: { ok: true },
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
          onRequest: () => {
            // Intentionally not calling emitStartEvent
          },
        });

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const req = new Request('http://test/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: 'ignored' }),
          signal: controller.signal,
        });

        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) =>
            takeFirstOrTimeout(stream),
          ),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(received).toBeUndefined();
    });
  });

  describe('auth', () => {
    test('auth rejects request with ExposeAuthError', async () => {
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

      const req = mockPostRequest({});
      await expect(
        api.createStream({ request: req }, (stream) => takeFirst(stream)),
      ).rejects.toThrow(ExposeAuthError);

      let err: ExposeAuthError;
      try {
        await api.createStream({ request: mockPostRequest({}) }, (stream) =>
          takeFirst(stream),
        );
        throw new Error('Expected ExposeAuthError');
      } catch (e) {
        err = e as ExposeAuthError;
      }
      expect(err.status).toBe(403);
      expect(err.message).toBe('Forbidden');
    });

    test('auth allows request when returning allowed: true', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ x: S.Number }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ ok: S.Boolean }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
              .logic(async ({ emit }) => {
                emit({
                  name: 'response',
                  payload: { ok: true },
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
          auth: () => ({ allowed: true }),
          onRequest: ({ emitStartEvent, req, payload }) =>
            emitStartEvent({
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: requestEvt.make(payload as { x: number }),
            }),
        });

        const req = mockPostRequest({ x: 1 });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'response',
        payload: { ok: true },
      });
    });
  });

  describe('Express req.body', () => {
    test('extracts payload from Express req.body when present', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ x: S.Number }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ doubled: S.Number }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
              .logic(async ({ triggerEvent, emit }) => {
                const p = triggerEvent.payload as { x: number };
                emit({
                  name: 'response',
                  payload: { doubled: p.x * 2 },
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
          triggerEvents: [requestEvt],
          onRequest: ({ emitStartEvent, req, payload }) =>
            emitStartEvent({
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: requestEvt.make(payload as { x: number }),
            }),
        });

        const exposeReq = {
          request: { signal: new AbortController().signal } as Request,
          req: { body: { x: 21 } },
          contextId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
        };

        return yield* Effect.tryPromise(() =>
          api.createStream(exposeReq, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'response',
        payload: { doubled: 42 },
      });
    });
  });

  describe('triggerEvents and setRunId/setContextId', () => {
    test('triggerEvents default ["request"] when not specified', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ x: S.Number }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ ok: S.Boolean }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
              .logic(async ({ emit }) => {
                emit({ name: 'response', payload: { ok: true } });
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
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: requestEvt.make(payload as { x: number }),
            }),
        });

        const req = mockPostRequest({ x: 1 });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(received).toMatchObject({
        name: 'response',
        payload: { ok: true },
      });
    });

    test('setRunId and setContextId override before emitStartEvent', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ x: S.Number }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ meta: S.Struct({ runId: S.String, contextId: S.String }) }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
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

        const customRunId = 'custom-run-123';
        const customContextId = 'custom-context-456';

        const api = network.expose({
          protocol: 'sse',
          plane,
          select: { channels: 'client' },
          onRequest: ({ setRunId, setContextId, emitStartEvent, payload }) => {
            setRunId(customRunId);
            setContextId(customContextId);
            emitStartEvent({
              contextId: customContextId,
              runId: customRunId,
              event: requestEvt.make(payload as { x: number }),
            });
          },
        });

        const req = mockPostRequest({ x: 1 });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(received).toMatchObject({
        name: 'response',
        payload: {
          meta: { runId: 'custom-run-123', contextId: 'custom-context-456' },
        },
      });
    });

    test('emitStartEvent with explicit contextId and runId', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ x: S.Number }),
      );
      const responseEvt = AgentNetworkEvent.of(
        'response',
        S.Struct({ meta: S.Struct({ runId: S.String, contextId: S.String }) }),
      );
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([responseEvt])
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
          onRequest: ({ emitStartEvent, payload }) =>
            emitStartEvent({
              contextId: 'explicit-context',
              runId: 'explicit-run',
              event: requestEvt.make(payload as { x: number }),
            }),
        });

        const req = mockPostRequest({ x: 1 });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(received).toMatchObject({
        name: 'response',
        payload: {
          meta: { runId: 'explicit-run', contextId: 'explicit-context' },
        },
      });
    });

    test('triggerEvents uses first for emit', async () => {
      const aEvt = AgentNetworkEvent.of('a', S.Struct({ v: S.Number }));
      const bEvt = AgentNetworkEvent.of('b', S.Struct({ v: S.Number }));
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([aEvt])
              .emits([bEvt])
              .logic(async ({ emit }) => {
                emit({ name: 'b', payload: { v: 2 } });
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
          triggerEvents: [aEvt, bEvt],
          onRequest: ({ emitStartEvent, req, payload }) =>
            emitStartEvent({
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: aEvt.make(payload ?? { v: 1 }),
            }),
        });

        const req = mockPostRequest({ v: 1 });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeFirst(stream)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));
      expect(received).toMatchObject({ name: 'b', payload: { v: 2 } });
    });
  });

  describe('event filter', () => {
    test('select.events filters streamed events', async () => {
      const requestEvt = AgentNetworkEvent.of(
        'request',
        S.Struct({ x: S.Number }),
      );
      const aEvt = AgentNetworkEvent.of('a', S.Struct({ v: S.Number }));
      const bEvt = AgentNetworkEvent.of('b', S.Struct({ v: S.Number }));
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([requestEvt])
              .emits([aEvt, bEvt])
              .logic(async ({ emit }) => {
                emit({
                  name: 'a',
                  payload: { v: 1 },
                });
                emit({
                  name: 'b',
                  payload: { v: 2 },
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
          select: { channels: 'client', events: ['b'] },
          onRequest: ({ emitStartEvent, req, payload }) =>
            emitStartEvent({
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: requestEvt.make(payload as { x: number }),
            }),
        });

        const req = mockPostRequest({ x: 0 });
        return yield* Effect.tryPromise(() =>
          api.createStream({ request: req }, (stream) => takeN(stream, 1)),
        );
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toHaveLength(1);
      expect(received![0]).toMatchObject({ name: 'b', payload: { v: 2 } });
    });
  });
});
