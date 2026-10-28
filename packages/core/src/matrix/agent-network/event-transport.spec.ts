// @vitest-environment node
import { Deferred, Effect, Fiber, Queue, Schema as S, type Scope } from 'effect';
import { describe, expect, expectTypeOf, it, test } from 'vitest';
import { runTransportContract } from '../../testing/index.js';
import { AgentFactory } from '../agent-factory.js';
import {
  createInMemoryTransport,
  type EventTransport,
  PublishAndAwaitTimeoutError,
} from '../index.js';
import { registerSSEStream } from '../io/proxy-consumer.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from './agent-network.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import { ChannelName } from './channel.js';
import { createEventPlane, type Envelope } from './event-plane.js';
import { RunLifecycleEvent } from './run-lifecycle.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const ask = AgentNetworkEvent.of('ask', S.Struct({ q: S.String }));
const reply = AgentNetworkEvent.of('reply', S.Struct({ a: S.String }));
const done = AgentNetworkEvent.of('done', S.Struct({ a: S.String }));

/** Wraps the in-memory transport, recording what the plane hands it. */
function recordingTransport(inner: EventTransport = createInMemoryTransport()) {
  const published: Array<{ channels: readonly string[]; name: string }> = [];
  const subscribed: string[] = [];
  const replies: string[] = [];
  const transport: EventTransport = {
    publish: (channels, envelope) => {
      published.push({ channels: [...channels], name: envelope.name });
      return inner.publish(channels, envelope);
    },
    subscribe: (channel, handler) => {
      subscribed.push(channel);
      return inner.subscribe(channel, handler);
    },
    expectReply: (request, match) => {
      replies.push(request.name);
      return inner.expectReply(request, match);
    },
  };
  return { transport, published, subscribed, replies };
}

/** start -> asker (emitAndAwait ask) -> answerer (reply) -> asker emits done to client. */
function askNetwork(options?: AgentNetworkSetupOptions) {
  return AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const work = createChannel('work');
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(
      AgentFactory.run()
        .listensTo([start])
        .emits([ask, done])
        .logic(async ({ emitAndAwait, emit }) => {
          const answer = await emitAndAwait(ask.make({ q: 'why' }), (e) => e.name === 'reply');
          emit(done.make({ a: (answer.payload as { a: string }).a }));
        })
        .produce({}),
    )
      .subscribe(mainChannel)
      .publishTo(work)
      .publishTo(client);
    registerAgent(
      AgentFactory.run()
        .listensTo([ask])
        .emits([reply], { reply: true })
        .logic(async ({ emit }) => {
          emit(reply.make({ a: 'because' }));
        })
        .produce({}),
    )
      .subscribe(work)
      .publishTo(work);
    endsOn(done);
  }, options);
}

const startEnvelope = (runId: string): Envelope => ({
  name: 'start',
  meta: { runId, contextId: 'ctx' },
  payload: {},
});

/** Takes from `queue` until the run-end event. */
const takeUntilRunEnd = (queue: Queue.Dequeue<Envelope>) =>
  Effect.gen(function* () {
    const names: string[] = [];
    while (true) {
      const envelope = yield* Queue.take(queue);
      names.push(envelope.name);
      if (envelope.name.startsWith('m4trix:run.')) return names;
    }
  });

describe('EventTransport', () => {
  describe('in-memory transport', () => {
    runTransportContract({ describe, it, expect }, () => createInMemoryTransport());

    test('publish completes once every subscriber handled the event (back-pressure)', async () => {
      const transport = createInMemoryTransport();
      const gate = Effect.runSync(Deferred.make<void>());
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* transport.subscribe('slow', () => Deferred.await(gate));
            const publishing = yield* Effect.fork(transport.publish(['slow'], startEnvelope('r')));
            yield* Effect.sleep('20 millis');
            expect(publishing.unsafePoll()).toBeNull();
            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.join(publishing);
          }),
        ),
      );
    });
  });

  describe('the event plane works through its transport', () => {
    test('network.run() publishes, subscribes and awaits replies through the setup transport', async () => {
      const recorded = recordingTransport();
      const network = askNetwork({ transport: recorded.transport });
      expect(network.getTransport()).toBe(recorded.transport);

      const names = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const plane = yield* network.run();
            const client = yield* plane.subscribe(ChannelName('client'));
            yield* plane.publish(ChannelName('main'), startEnvelope('run-1'));
            return yield* takeUntilRunEnd(client);
          }),
        ),
      );

      expect(names).toEqual(['ask', 'done', RunLifecycleEvent.completed]);
      expect(recorded.subscribed).toContain('client');
      expect(recorded.replies).toEqual(['ask']);
      expect(recorded.published).toEqual(
        expect.arrayContaining([
          { channels: ['main'], name: 'start' },
          { channels: ['work', 'client'], name: 'ask' },
          { channels: ['work'], name: 'reply' },
          { channels: ['work', 'client'], name: 'done' },
        ]),
      );
    });

    test('expose() planes use the setup transport too', async () => {
      const recorded = recordingTransport();
      const network = askNetwork({ transport: recorded.transport });
      const api = network.expose(registerSSEStream({ triggerEvents: [start] }));

      const events: string[] = [];
      await api.createStream(
        {
          request: new Request('http://test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
        },
        async (stream) => {
          for await (const e of stream) events.push(e.name);
        },
      );

      expect(events).toEqual(['ask', 'done', RunLifecycleEvent.completed]);
      expect(recorded.replies).toEqual(['ask']);
    });

    test('planes sharing a transport see each other’s channel events and replies', async () => {
      const transport = createInMemoryTransport();
      const network = askNetwork({ transport });

      const [onB, replied] = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const planeA = yield* createEventPlane({ network });
            const planeB = yield* createEventPlane({ network });
            const clientOnB = yield* planeB.subscribe(ChannelName('client'));
            const work = network.getChannels().get(ChannelName('work'));
            if (!work) throw new Error('no work channel');

            yield* planeA.publish(ChannelName('client'), {
              name: 'done',
              meta: { runId: 'shared', contextId: 'ctx' },
              payload: { a: 'from A' },
            });
            const received = yield* Queue.take(clientOnB);

            const awaiting = yield* Effect.fork(
              planeA.publishAndAwait(
                [work],
                { name: 'ask', meta: { runId: 'x', contextId: 'ctx' }, payload: { q: '?' } },
                (e) => e.name === 'reply',
              ),
            );
            yield* Effect.sleep('10 millis');
            yield* planeB.publish(ChannelName('work'), {
              name: 'reply',
              meta: { runId: 'x', contextId: 'ctx' },
              payload: { a: 'from B' },
            });
            const answer = yield* Fiber.join(awaiting);
            return [received.payload, answer.payload] as const;
          }),
        ),
      );

      expect(onB).toEqual({ a: 'from A' });
      expect(replied).toEqual({ a: 'from B' });
    });
  });

  describe('PublishAndAwaitTimeoutError', () => {
    test('is exported and is what a timed-out publishAndAwait fails with', async () => {
      const network = askNetwork({ logger: { warn: () => {} } });
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const plane = yield* createEventPlane({ network });
            const work = network.getChannels().get(ChannelName('work'));
            if (!work) throw new Error('no work channel');
            return yield* Effect.flip(
              plane.publishAndAwait(
                [work],
                { name: 'ask', meta: { runId: 'r', contextId: 'c' }, payload: { q: '?' } },
                () => false,
                { timeout: '10 millis' },
              ),
            );
          }),
        ),
      );

      expect(error).toBeInstanceOf(PublishAndAwaitTimeoutError);
      expect(error._tag).toBe('PublishAndAwaitTimeoutError');
      expect((error as PublishAndAwaitTimeoutError).timeout).toBe('10 millis');
    });
  });

  test('types', () => {
    expectTypeOf<EventTransport['publish']>().toEqualTypeOf<
      (channels: ReadonlyArray<string>, envelope: Envelope) => Effect.Effect<void>
    >();
    expectTypeOf<EventTransport['subscribe']>().toEqualTypeOf<
      (
        channel: string,
        handler: (envelope: Envelope) => Effect.Effect<void>,
      ) => Effect.Effect<void, never, Scope.Scope>
    >();
    expectTypeOf<EventTransport['expectReply']>().toEqualTypeOf<
      (
        request: Envelope,
        match: (reply: Envelope) => boolean,
      ) => Effect.Effect<Effect.Effect<Envelope>, never, Scope.Scope>
    >();
    expectTypeOf(createInMemoryTransport()).toEqualTypeOf<EventTransport>();
    expectTypeOf<AgentNetworkSetupOptions['transport']>().toEqualTypeOf<
      EventTransport | undefined
    >();
    expectTypeOf<
      PublishAndAwaitTimeoutError['_tag']
    >().toEqualTypeOf<'PublishAndAwaitTimeoutError'>();
  });
});
