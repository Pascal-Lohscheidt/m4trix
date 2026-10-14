import { Effect, Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';
import { AgentNetwork } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import { Proxy as ChannelProxy } from '../agent-network/channel.js';
import {
  defineProxyKind,
  registerSSEStream,
  resolveChannelsForProxyKind,
} from './proxy-consumer.js';

describe('proxy consumer', () => {
  test('registerSSEStream creates an sse consumer', () => {
    const consumer = registerSSEStream({ channel: 'client', events: ['message'] });

    expect(consumer).toMatchObject({
      _tag: 'BuiltinProxyConsumer',
      kind: 'sse',
      options: { channel: 'client', events: ['message'] },
    });
  });

  test('explicit channel resolves when it declares the proxy kind', () => {
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.sse());
    });

    expect(resolveChannelsForProxyKind(network, 'sse', 'client')).toEqual(['client']);
  });

  test('explicit channel without matching proxy throws', () => {
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.custom('queue', { topic: 'events' }));
    });

    expect(() => resolveChannelsForProxyKind(network, 'sse', 'client')).toThrow(
      'does not declare Proxy kind "sse"',
    );
  });

  test('explicit unknown channel throws', () => {
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.sse());
    });

    expect(() => resolveChannelsForProxyKind(network, 'sse', 'missing')).toThrow(
      'channel "missing" does not exist',
    );
  });

  test('single matching proxy channel auto-resolves', () => {
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('internal');
      createChannel('client').proxy(proxy.sse());
    });

    expect(resolveChannelsForProxyKind(network, 'sse')).toEqual(['client']);
  });

  test('multiple matching proxy channels require explicit channel selection', () => {
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.sse());
      createChannel('events').proxy(proxy.sse());
    });

    expect(() => resolveChannelsForProxyKind(network, 'sse')).toThrow(
      'multiple channels declare Proxy kind "sse"',
    );
  });

  test('zero matching proxy channels falls back to client channel', () => {
    const network = AgentNetwork.setup(({ createChannel }) => {
      createChannel('client');
    });

    expect(resolveChannelsForProxyKind(network, 'sse')).toEqual(['client']);
  });

  test('custom proxy kind matches only the declared custom kind', () => {
    const trpcStream = defineProxyKind('trpc-stream');
    const network = AgentNetwork.setup(({ createChannel }) => {
      createChannel('client').proxy(trpcStream.onChannel());
      createChannel('events').proxy(ChannelProxy.custom('queue', { topic: 'events' }));
    });

    expect(resolveChannelsForProxyKind(network, 'trpc-stream')).toEqual(['client']);
    expect(() => resolveChannelsForProxyKind(network, 'sse', 'client')).toThrow(
      'does not declare Proxy kind "sse"',
    );
  });

  test('inbound publish without a shared plane throws clearly', async () => {
    const event = AgentNetworkEvent.of('human-approved', S.Struct({ approved: S.Boolean }));
    const api = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.sse());
    }).expose(registerSSEStream({ channel: 'client' }));

    await expect(api.publish(event.make({ approved: true }), { target: 'main' })).rejects.toThrow(
      'proxy.publish requires a shared event plane',
    );
  });

  test('withMeta publishes inbound events with the meta it was given', async () => {
    const event = AgentNetworkEvent.of('human-approved', S.Struct({ approved: S.Boolean }));
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.sse());
    });

    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(registerSSEStream({ channel: 'client', plane }));
        yield* Effect.promise(() =>
          api
            .withMeta({ runId: 'run-1', contextId: 'ctx', eventId: 'evt-1', depth: 2, ts: 5 })
            .publish(event.make({ approved: true }), 'main'),
        );
        return yield* Effect.promise(() =>
          plane.history({ runId: 'run-1', contextId: 'ctx' }).run(),
        );
      }).pipe(Effect.scoped),
    );

    expect(stored[0]?.meta).toMatchObject({ eventId: 'evt-1', depth: 2, ts: 5 });
  });
});
