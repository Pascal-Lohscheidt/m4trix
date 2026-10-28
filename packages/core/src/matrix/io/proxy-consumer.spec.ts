import { Effect, Schema as S } from 'effect';
import { describe, expect, test } from 'vitest';
import { AgentNetwork } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import { Proxy as ChannelProxy } from '../agent-network/channel.js';
import { inspectRun } from '../agent-network/event-plane.js';
import { ReservedEventNameError } from '../agent-network/run-lifecycle.js';
import { NonJsonPayloadError } from '../agent-network/stored-payload.js';
import { ChannelName } from '../identifiers/channel-name.js';
import {
  createProxyExposeContext,
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

  test('inbound publishes refuse reserved m4trix: names: publish, withMeta and publishInbound', async () => {
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.sse());
    });
    const forged = {
      name: 'm4trix:fold.checkpoint:conversation@1',
      payload: { fold: 'conversation', version: 1, through: null, state: { turns: [] } },
    };
    const meta = { runId: 'run-1', contextId: 'ctx' };

    const { errors, stored } = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(registerSSEStream({ channel: 'client', plane }));
        const options = { channel: 'client', plane };
        const context = createProxyExposeContext({
          network,
          channels: [ChannelName('client')],
          options,
          createInteractiveStream: () => {
            throw new Error('not used');
          },
        });
        const errors = yield* Effect.promise(() =>
          Promise.all(
            [
              () => api.publish(forged, { target: 'main', meta }),
              () => api.withMeta(meta).publish(forged, 'main'),
              () => context.publishInbound({ ...forged, meta }),
            ].map((publish) =>
              publish().then(
                () => undefined,
                (error: unknown) => error,
              ),
            ),
          ),
        );
        const stored = yield* Effect.promise(() => plane.history(meta).run());
        return { errors, stored };
      }).pipe(Effect.scoped),
    );

    expect(errors).toEqual([
      expect.any(ReservedEventNameError),
      expect.any(ReservedEventNameError),
      expect.any(ReservedEventNameError),
    ]);
    expect(errors[0]).toMatchObject({ eventName: 'm4trix:fold.checkpoint:conversation@1' });
    expect(stored).toEqual([]);
  });

  test("a principal's publish to a run another principal claimed resolves false; nothing is stored", async () => {
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').proxy(proxy.sse());
    });
    const event = { name: 'note', payload: { text: 'hi' } };
    const meta = { runId: 'run-1', contextId: 'ctx' };

    const { results, stored } = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(registerSSEStream({ channel: 'client', plane }));
        const results = [
          yield* Effect.promise(() => api.publish(event, { meta, principal: { id: 'alice' } })),
          yield* Effect.promise(() => api.publish(event, { meta, principal: { id: 'mallory' } })),
        ];
        const stored = yield* Effect.promise(() =>
          plane.history({ ...meta, principalId: 'mallory' }).run(),
        );
        return { results, stored };
      }).pipe(Effect.scoped),
    );

    expect(results).toEqual([true, false]);
    expect(stored).toEqual([]);
  });

  test('an inbound publish makes its stored payload once: checked before the claim, then reused', async () => {
    const Note = AgentNetworkEvent.of('note', S.Struct({ data: S.Unknown }));
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').events([Note]).proxy(proxy.sse());
    });
    /** A payload counting how often it is turned into JSON. */
    const counted = () => {
      const count = { calls: 0 };
      const data = {
        toJSON: () => {
          count.calls++;
          return 'kept';
        },
      };
      return { count, payload: { data } };
    };
    const viaProxy = counted();
    const direct = counted();

    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(registerSSEStream({ channel: 'client', plane }));
        const meta = (runId: string) => ({ runId, contextId: 'ctx' });
        yield* Effect.promise(() =>
          api.publish({ name: 'note', payload: viaProxy.payload }, { meta: meta('run-1') }),
        );
        yield* plane.publish(ChannelName('client'), {
          name: 'note',
          meta: meta('run-2'),
          payload: direct.payload,
        });
        return yield* Effect.promise(() => plane.history(meta('run-1')).run());
      }).pipe(Effect.scoped),
    );

    expect(stored.map((event) => event.payload)).toEqual([{ data: 'kept' }]);
    // As often as plane.publish, which makes it once (its trace span serializes it too).
    expect(viaProxy.count.calls).toBe(direct.count.calls);
  });

  test('inbound publishes refuse payloads JSON cannot hold, before they claim the run', async () => {
    const Note = AgentNetworkEvent.of('note', S.Struct({ data: S.Unknown }));
    const network = AgentNetwork.setup(({ createChannel, proxy }) => {
      createChannel('client').events([Note]).proxy(proxy.sse());
    });
    // E.g. an in-process bridge relaying a value as it is, not its wire form.
    const unstorable = { name: 'note', payload: { data: new Map([['k', 1]]) } };
    const meta = { runId: 'run-1', contextId: 'ctx' };
    const principal = { id: 'user-1' };

    const { errors, stored, run } = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const api = network.expose(registerSSEStream({ channel: 'client', plane }));
        const context = createProxyExposeContext({
          network,
          channels: [ChannelName('client')],
          options: { channel: 'client', plane },
          createInteractiveStream: () => {
            throw new Error('not used');
          },
        });
        const errors = yield* Effect.promise(() =>
          Promise.all(
            [
              () => api.publish(unstorable, { meta, principal }),
              () => api.withMeta(meta, { principal }).publish(unstorable),
              () => context.publishInbound({ ...unstorable, meta }, 'main', { principal }),
              () =>
                api.publish(
                  {
                    name: 'note',
                    payload: {
                      data: {
                        toJSON(): never {
                          throw new Error('toJSON failed');
                        },
                      },
                    },
                  },
                  { meta, principal },
                ),
            ].map((publish) =>
              publish().then(
                () => undefined,
                (error: unknown) => error,
              ),
            ),
          ),
        );
        const stored = yield* Effect.promise(() =>
          plane.history({ ...meta, principalId: principal.id }).run(),
        );
        return { errors, stored, run: inspectRun(plane, 'run-1') };
      }).pipe(Effect.scoped),
    );

    expect(errors).toEqual([
      expect.any(NonJsonPayloadError),
      expect.any(NonJsonPayloadError),
      expect.any(NonJsonPayloadError),
      expect.any(NonJsonPayloadError),
    ]);
    expect(errors[0]).toMatchObject({ eventName: 'note', path: 'data', found: 'a Map' });
    expect(errors[3]).toMatchObject({ path: 'data', found: 'an object whose toJSON threw' });
    expect(stored).toEqual([]);
    // Nothing claimed the run: another principal may still start it.
    expect(run).toBeUndefined();
  });
});
