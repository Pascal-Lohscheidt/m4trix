import { Chunk, Effect, Queue, Schema as S } from 'effect';
import { describe, expect, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { ChannelName } from '../identifiers/channel-name.js';
import { registerSSEStream } from '../io/proxy-consumer.js';
import { EmitValidationError } from '../validation.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import type { ConfiguredChannel } from './channel.js';
import type { Envelope, EventPlane } from './event-plane.js';
import { type RunFailedPayload, RunLifecycleEvent } from './run-lifecycle.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
const note = AgentNetworkEvent.of('note', S.Struct({ from: S.String }));

const main = ChannelName('main');
const client = ChannelName('client');
const meta = { runId: 'run-1', contextId: 'ctx-1' };

const drain = (queue: Queue.Dequeue<Envelope>) =>
  Effect.map(Queue.takeAll(queue), (chunk) => [...Chunk.toReadonlyArray(chunk)]);

const quietLogger = () => ({ warn: vi.fn<(message: string, data?: unknown) => void>() });

/** Runs `body` on a fresh plane of `network`, with subscriptions to main and client. */
function onPlane<A>(
  network: AgentNetwork,
  body: (ctx: {
    plane: EventPlane;
    main: Queue.Dequeue<Envelope>;
    client: Queue.Dequeue<Envelope>;
  }) => Effect.Effect<A, unknown>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const plane = yield* network.run();
      return yield* body({
        plane,
        main: yield* plane.subscribe(main),
        client: yield* plane.subscribe(client),
      });
    }).pipe(Effect.scoped),
  );
}

describe('channel.events([...]) enforcement', () => {
  test('an agent publishing only to channels that do not accept an event fails with EmitValidationError (channel)', async () => {
    let caught: unknown;
    let clientChannel: ConfiguredChannel | undefined;
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer, note])
      .logic(async ({ emit }) => {
        try {
          emit(note.make({ from: 'agent' }));
        } catch (error) {
          caught = error;
        }
      })
      .produce({});
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, registerAgent }) => {
        clientChannel = createChannel('client');
        registerAgent(agent).subscribe(mainChannel).publishTo(clientChannel);
      },
      { logger: quietLogger() },
    );
    // Declared after setup, so only the runtime check can catch it.
    clientChannel?.events([answer]);

    const { onClient, outcome } = await onPlane(network, ({ plane, client: clientQueue }) =>
      Effect.gen(function* () {
        yield* plane.publish(main, start.makeBound(meta, {}));
        const outcome = yield* plane.awaitRunEnd(meta.runId);
        yield* Effect.sleep('10 millis');
        return { onClient: yield* drain(clientQueue), outcome };
      }),
    );

    expect(caught).toBeInstanceOf(EmitValidationError);
    expect(caught).toMatchObject({ reason: 'channel', eventName: 'note', agentId: agent.getId() });
    expect((caught as Error).message).toContain('"client"');
    expect(onClient.map((e) => e.name)).toEqual([RunLifecycleEvent.failed]);
    expect((outcome.payload as RunFailedPayload).error).toMatchObject({
      kind: 'invalid-emit',
      event: 'note',
    });
  });

  test("an agent's event goes to those of its channels that accept it", async () => {
    const agent = AgentFactory.run()
      .listensTo([start])
      .emits([answer, note])
      .logic(async ({ emit }) => {
        emit(note.make({ from: 'agent' }));
        emit(answer.make({ text: 'ok' }));
      })
      .produce({});
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, registerAgent, endsOn }) => {
        const clientChannel = createChannel('client').events([answer]);
        registerAgent(agent).subscribe(mainChannel).publishTo(clientChannel).publishTo(mainChannel);
        endsOn(answer);
      },
      { logger: quietLogger() },
    );

    const seen = await onPlane(network, ({ plane, main: mainQueue, client: clientQueue }) =>
      Effect.gen(function* () {
        yield* plane.publish(main, start.makeBound(meta, {}));
        yield* plane.awaitRunEnd(meta.runId);
        yield* Effect.sleep('10 millis');
        return { main: yield* drain(mainQueue), client: yield* drain(clientQueue) };
      }),
    );

    expect(seen.main.map((e) => e.name)).toEqual([
      'start',
      'note',
      'answer',
      RunLifecycleEvent.completed,
    ]);
    // Lifecycle events always pass, whatever the channel declares.
    expect(seen.client.map((e) => e.name)).toEqual(['answer', RunLifecycleEvent.completed]);
  });

  test('an external publish of an event the channel does not accept resolves false, is not delivered and is logged', async () => {
    const logger = quietLogger();
    const triggers: string[] = [];
    const network = AgentNetwork.setup(
      ({ createChannel, registerAgent }) => {
        const clientChannel = createChannel('client').events([answer]);
        // Listens to everything on client.
        registerAgent(
          AgentFactory.run()
            .logic(async ({ triggerEvent }) => {
              triggers.push((triggerEvent as Envelope).name);
            })
            .produce({}),
        ).subscribe(clientChannel);
      },
      { logger },
    );

    const result = await onPlane(network, ({ plane, client: clientQueue }) =>
      Effect.gen(function* () {
        const refused = yield* plane.publish(client, note.makeBound(meta, { from: 'outside' }));
        const accepted = yield* plane.publish(client, answer.makeBound(meta, { text: 'hi' }));
        yield* Effect.sleep('10 millis');
        return { refused, accepted, onClient: yield* drain(clientQueue) };
      }),
    );

    expect(result.refused).toBe(false);
    expect(result.accepted).toBe(true);
    expect(result.onClient.map((e) => e.name)).toEqual(['answer']);
    expect(triggers).toEqual(['answer']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/refused "note".*"client"/),
      expect.objectContaining({ event: 'note', channel: 'client', runId: 'run-1' }),
    );
  });

  test('proxy publishes are refused the same way', async () => {
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, proxy }) => {
        mainChannel.events([start]);
        createChannel('client').proxy(proxy.sse());
      },
      { logger: quietLogger() },
    );

    const results = await onPlane(network, ({ plane }) =>
      Effect.promise(async () => {
        const api = network.expose(registerSSEStream({ plane }));
        return [
          await api.publish(note.make({ from: 'proxy' }), { meta }),
          await api.publish(start.make({}), { meta }),
        ];
      }),
    );

    expect(results).toEqual([false, true]);
  });

  test('channels without declared events accept everything', async () => {
    const network = AgentNetwork.setup(({ createChannel }) => {
      createChannel('client');
    });

    const result = await onPlane(network, ({ plane, client: clientQueue }) =>
      Effect.gen(function* () {
        const published = yield* plane.publish(client, note.makeBound(meta, { from: 'x' }));
        yield* plane.publish(client, { name: 'anything', meta, payload: 1 });
        yield* Effect.sleep('10 millis');
        return { published, names: (yield* drain(clientQueue)).map((e) => e.name) };
      }),
    );

    expect(result).toEqual({ published: true, names: ['note', 'anything'] });
  });

  test('the run-end event reaches channels with declared events', async () => {
    const network = AgentNetwork.setup(
      ({ createChannel }) => {
        createChannel('client').events([answer]);
      },
      { logger: quietLogger() },
    );

    const names = await onPlane(network, ({ plane, client: clientQueue }) =>
      Effect.gen(function* () {
        yield* plane.endRun(meta, { status: 'cancelled', payload: { reason: 'stream-closed' } });
        return (yield* drain(clientQueue)).map((e) => e.name);
      }),
    );

    expect(names).toEqual([RunLifecycleEvent.cancelled]);
  });
});

describe('logger option', () => {
  test('is part of the setup options', () => {
    const options: AgentNetworkSetupOptions = { logger: { warn: () => {} } };
    expect(options.logger).toBeDefined();
  });
});
