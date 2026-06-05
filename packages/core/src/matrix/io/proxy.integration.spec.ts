import { Effect, Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import { defineProxyKind, registerSSEStream } from './proxy-consumer.js';
import type { ExposedStream } from './types.js';

async function takeFirst(stream: ExposedStream): Promise<unknown> {
  for await (const envelope of stream) return envelope;
  return undefined;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('proxy integration', () => {
  test('proxy.sse + registerSSEStream streams agent output', async () => {
    const request = AgentNetworkEvent.of('request', S.Struct({ message: S.String }));
    const response = AgentNetworkEvent.of('response', S.Struct({ message: S.String }));

    const network = AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent }) => {
      const client = createChannel('client').proxy(proxy.sse());
      registerAgent(
        AgentFactory.run()
          .listensTo([request])
          .emits([response])
          .logic(async ({ triggerEvent, emit }) => {
            emit(
              response.make({
                message: `Echo: ${(triggerEvent.payload as { message: string }).message}`,
              }),
            );
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose(
        registerSSEStream({
          channel: 'client',
          plane,
          triggerEvents: [request],
          onRequest: ({ emitStartEvent, req, payload }) =>
            emitStartEvent({
              contextId: req.contextId ?? crypto.randomUUID(),
              runId: req.runId ?? crypto.randomUUID(),
              event: request.make(payload),
            }),
        }),
      );

      return yield* Effect.tryPromise(() =>
        api.createStream(
          {
            request: new Request('http://test.local', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: 'hello' }),
            }),
          },
          takeFirst,
        ),
      );
    });

    await expect(Effect.runPromise(program.pipe(Effect.scoped))).resolves.toMatchObject({
      name: 'response',
      payload: { message: 'Echo: hello' },
    });
  });

  test('publish sends human-in-the-loop events into the network with optional meta', async () => {
    const approved = AgentNetworkEvent.of('human-approved', S.Struct({ approved: S.Boolean }));
    const ack = AgentNetworkEvent.of('human-ack', S.Struct({ approved: S.Boolean }));

    const network = AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent }) => {
      const client = createChannel('client').proxy(proxy.sse());
      registerAgent(
        AgentFactory.run()
          .listensTo([approved])
          .emits([ack])
          .logic(async ({ triggerEvent, emit }) => {
            emit(ack.make({ approved: (triggerEvent.payload as { approved: boolean }).approved }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');
      const api = network.expose(registerSSEStream({ channel: 'client', plane }));

      const started = deferred();
      const receivedPromise = api.createStream(
        { request: new Request('http://test.local') },
        async (stream) => {
          started.resolve();
          return takeFirst(stream);
        },
      );
      yield* Effect.promise(() => started.promise);

      yield* Effect.promise(() =>
        api.publish(approved.make({ approved: true }), {
          target: 'main',
          meta: { runId: 'hitl-run', contextId: 'hitl-context' },
        }),
      );

      return yield* Effect.tryPromise(() => receivedPromise);
    });

    await expect(Effect.runPromise(program.pipe(Effect.scoped))).resolves.toMatchObject({
      name: 'human-ack',
      meta: { runId: 'hitl-run', contextId: 'hitl-context' },
      payload: { approved: true },
    });
  });

  test('custom proxy can wrap createInteractiveStream', async () => {
    const custom = defineProxyKind('custom-stream');
    const request = AgentNetworkEvent.of('custom-request', S.Struct({ value: S.Number }));
    const response = AgentNetworkEvent.of('custom-response', S.Struct({ value: S.Number }));

    const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
      const client = createChannel('client').proxy(custom.onChannel());
      registerAgent(
        AgentFactory.run()
          .listensTo([request])
          .emits([response])
          .logic(async ({ triggerEvent, emit }) => {
            emit(response.make({ value: (triggerEvent.payload as { value: number }).value + 1 }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(client);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      yield* Effect.sleep('10 millis');

      const api = network.expose(
        custom.register({ channel: 'client', plane }, ({ createInteractiveStream }) =>
          createInteractiveStream({
            plane,
            triggerEvents: [request],
            onRequest: ({ emitStartEvent, req, payload }) =>
              emitStartEvent({
                contextId: req.contextId ?? crypto.randomUUID(),
                runId: req.runId ?? crypto.randomUUID(),
                event: request.make(payload),
              }),
          }),
        ),
      );

      return yield* Effect.tryPromise(() =>
        api.createStream(
          {
            request: new Request('http://test.local', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: 41 }),
            }),
          },
          takeFirst,
        ),
      );
    });

    await expect(Effect.runPromise(program.pipe(Effect.scoped))).resolves.toMatchObject({
      name: 'custom-response',
      payload: { value: 42 },
    });
  });
});
