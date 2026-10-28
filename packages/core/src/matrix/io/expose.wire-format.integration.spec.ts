/**
 * The wire format: everything that leaves the network carries payloads encoded with their event's
 * schema, the form the store keeps. A live SSE stream and a resumed one (replayed from the store)
 * send the very same data.
 */
import { Effect, Redacted, Schema as S } from 'effect';
import { describe, expect, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import type { Envelope } from '../agent-network/event-plane.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import { ContextFold } from '../context/context-fold.js';
import { RunLifecycleEvent } from '../agent-network/run-lifecycle.js';
import { NextEndpoint } from './adapters/next-endpoint.js';
import { defineProxyKind, registerSSEStream } from './proxy-consumer.js';
import type { ExposedStream } from './types.js';

const Start = AgentNetworkEvent.of('start', S.Struct({ count: S.NumberFromString }));
/** Durable, transforming: `{ n: 2, at: Date }` is `{ n: '2', at: '2026-…Z' }` on the wire. */
const Measured = AgentNetworkEvent.of('measured', S.Struct({ n: S.NumberFromString, at: S.Date }));
/** Transient, transforming: never stored, encoded for the wire all the same. */
const Ticked = AgentNetworkEvent.of('ticked', S.Struct({ big: S.BigInt }), { transient: true });
const Answer = AgentNetworkEvent.of('answer', S.Struct({ total: S.NumberFromString }));

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

/** start -> measured x2, ticked (transient), answer (terminal), all on the client channel. */
function measuringNetwork() {
  return AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(
      AgentFactory.run()
        .listensTo([Start])
        .emits([Measured, Ticked, Answer])
        .logic(async ({ triggerEvent, emit }) => {
          // Agents get the decoded payload.
          const count: number = triggerEvent.payload.count;
          emit({ name: 'measured', payload: { n: count, at: day(1) } });
          emit({ name: 'ticked', payload: { big: 12345678901234567890n } });
          emit({ name: 'measured', payload: { n: count + 1, at: day(2) } });
          emit({ name: 'answer', payload: { total: count * 2 + 1 } });
        })
        .produce({}),
    )
      .subscribe(mainChannel)
      .publishTo(client);
    endsOn(Answer);
  });
}

const post = (body: unknown): Request =>
  new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The stream's envelopes with their SSE ids. */
const collect = async (stream: ExposedStream) => {
  const seen: Array<{ envelope: Envelope; id: string | undefined }> = [];
  for await (const envelope of stream) seen.push({ envelope, id: stream.idOf?.(envelope) });
  return seen;
};

/** `data:` of each SSE message, parsed, by event name. */
const sseData = (text: string) =>
  text
    .split('\n\n')
    .filter((message) => message.includes('data: '))
    .map((message) => {
      const name = /^event: (.*)$/m.exec(message)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(message)?.[1] ?? 'null') as Envelope;
      return { name, payload: data.payload };
    });

describe('wire format: payloads leave the network encoded with their event schema', () => {
  test('a live SSE stream sends encoded payloads, durable and transient alike', async () => {
    const api = measuringNetwork().expose(registerSSEStream({ triggerEvents: [Start] }));
    const handler = NextEndpoint.from(api, {
      requestToContextId: () => 'ctx',
      requestToRunId: () => 'run-1',
    }).handler();

    const text = await (await handler(post({ count: '2' }))).text();

    expect(sseData(text).filter(({ name }) => !name?.startsWith('m4trix:'))).toEqual([
      { name: 'measured', payload: { n: '2', at: '2026-01-01T00:00:00.000Z' } },
      { name: 'ticked', payload: { big: '12345678901234567890' } },
      { name: 'measured', payload: { n: '3', at: '2026-01-02T00:00:00.000Z' } },
      { name: 'answer', payload: { total: '5' } },
    ]);
  });

  test('a transient event with S.Redacted streams "<redacted>", the rest of it encoded', async () => {
    const Typing = AgentNetworkEvent.of(
      'typing',
      S.Struct({ token: S.Redacted(S.String), n: S.NumberFromString }),
      { transient: true },
    );
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
        const client = createChannel('client').proxy(proxy.sse());
        registerAgent(
          AgentFactory.run()
            .listensTo([Start])
            .emits([Typing, Answer])
            .logic(async ({ emit }) => {
              emit({ name: 'typing', payload: { token: Redacted.make('hunter2'), n: 1 } });
              emit({ name: 'answer', payload: { total: 1 } });
            })
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(client);
        endsOn(Answer);
      },
    );
    const handler = NextEndpoint.from(
      network.expose(registerSSEStream({ triggerEvents: [Start] })),
      {
        requestToContextId: () => 'ctx',
        requestToRunId: () => 'run-1',
      },
    ).handler();

    const text = await (await handler(post({ count: '1' }))).text();

    expect(sseData(text).find(({ name }) => name === 'typing')?.payload).toEqual({
      token: '<redacted>',
      n: '1',
    });
    expect(text).not.toContain('hunter2');
  });

  test('a resumed stream replays exactly what the live stream sent', async () => {
    const api = measuringNetwork().expose(registerSSEStream({ triggerEvents: [Start] }));

    const live = await api.createStream(
      { request: post({ count: '2' }), contextId: 'ctx', runId: 'run-1' },
      collect,
    );
    const [first] = live;
    const resumed = await api.createStream(
      {
        request: new Request('http://test/api', { headers: { 'Last-Event-ID': first?.id ?? '' } }),
      },
      collect,
    );

    const durable = live.slice(1).filter(({ id }) => id !== undefined);
    expect(durable.map(({ envelope }) => envelope.name)).toEqual([
      'measured',
      'answer',
      RunLifecycleEvent.completed,
    ]);
    expect(resumed.map(({ envelope }) => JSON.stringify(envelope))).toEqual(
      durable.map(({ envelope }) => JSON.stringify(envelope)),
    );
    // A client decodes the wire payload with the event schema to get the typed value back.
    expect(S.decodeUnknownSync(Measured.payload)(resumed[0]?.envelope.payload)).toEqual({
      n: 3,
      at: day(2),
    });
  });

  test('an outbound custom proxy gets the wire form too', async () => {
    const outbound = defineProxyKind('outbound-feed');
    const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
      const feed = createChannel('feed').proxy(outbound.onChannel());
      registerAgent(
        AgentFactory.run()
          .listensTo([Start])
          .emits([Measured])
          .logic(async ({ emit }) => emit({ name: 'measured', payload: { n: 7, at: day(3) } }))
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(feed);
    });

    const received = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const controller = new AbortController();
        const seen: Envelope[] = [];
        let done!: () => void;
        const arrived = new Promise<void>((resolve) => {
          done = resolve;
        });
        let subscribed!: () => void;
        const ready = new Promise<void>((resolve) => {
          subscribed = resolve;
        });
        network.expose(
          outbound.register({ channel: 'feed', plane }, (ctx) => {
            void ctx.subscribeOutbound((envelope) => {
              seen.push(envelope);
              done();
            }, controller.signal);
            subscribed();
            return ctx.createInteractiveStream({ plane, reconnectWindow: 0 });
          }),
        );
        yield* Effect.promise(() => ready);
        yield* Effect.sleep('10 millis');
        yield* plane.publish(network.getMainChannel()?.name ?? ('main' as never), {
          name: 'start',
          meta: { runId: 'run-1', contextId: 'ctx' },
          payload: { count: 1 },
        });
        yield* Effect.promise(() => arrived);
        controller.abort();
        return seen;
      }).pipe(Effect.scoped),
    );

    expect(received[0]?.payload).toEqual({ n: '7', at: '2026-01-03T00:00:00.000Z' });
  });
});

describe('inbound: what arrives from outside is wire data, decoded with its event schema', () => {
  /** String-to-string codecs (any string is both an encoded and a decoded value), and others. */
  const Coded = AgentNetworkEvent.of(
    'coded',
    S.Struct({
      b64: S.StringFromBase64,
      json: S.parseJson(S.String),
      uri: S.StringFromUriComponent,
      n: S.NumberFromString,
      at: S.Date,
    }),
  );
  /** Only string-to-string codecs: nothing about the value tells its form. */
  const Strings = AgentNetworkEvent.of(
    'strings',
    S.Struct({ b64: S.StringFromBase64, uri: S.StringFromUriComponent }),
  );
  const Done = AgentNetworkEvent.of('done', S.Struct({}));
  const Inbound = defineProxyKind('inbound-feed', { direction: 'inbound' });
  const wire = {
    b64: 'aGk=',
    json: '"hi"',
    uri: 'a%20b',
    n: '5',
    at: '2026-01-02T00:00:00.000Z',
  };
  const decoded = { b64: 'hi', json: 'hi', uri: 'a b', n: 5, at: day(2) };

  /** A network whose agent records the payloads of `event` it gets and what its fold reads. */
  const recording = (event: typeof Coded | typeof Strings = Coded) => {
    const store = createInMemoryNetworkStore();
    const received: unknown[] = [];
    const folded: unknown[] = [];
    const Seen = ContextFold.of('seen')
      .initial((): ReadonlyArray<unknown> => [])
      .on(event, (all, { payload }) => [...all, payload]);
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent, endsOn }) => {
        mainChannel.proxy(Inbound.onChannel());
        registerAgent(
          AgentFactory.run()
            .listensTo([event])
            .emits([Done])
            .folds([Seen])
            .logic(async ({ triggerEvent, folds, emit }) => {
              received.push(triggerEvent.payload);
              folded.push(...(await folds.seen()));
              emit(Done.make({}));
            })
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(mainChannel);
        endsOn(Done);
      },
      { store, logger: { warn: vi.fn(), error: vi.fn() } },
    );
    const stored = async (name: string) =>
      (await store.readRun({ namespace: 'anonymous', contextId: 'ctx' }, 'run-1')).find(
        (stored) => stored.name === name,
      )?.payload;
    return { network, received, folded, stored };
  };

  /** Publishes `payload` through a proxy of a shared plane; resolves once the run ended. */
  const viaProxy = (
    network: AgentNetwork,
    payload: unknown,
    publish: 'publish' | 'publishInbound' = 'publish',
    name = 'coded',
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        let ctx!: Parameters<Parameters<typeof Inbound.register>[1]>[0];
        network.expose(
          Inbound.register({ channel: 'main', plane }, (context) => {
            ctx = context;
            return context.createInteractiveStream({ plane, reconnectWindow: 0 });
          }),
        );
        const meta = { runId: 'run-1', contextId: 'ctx' };
        yield* Effect.promise(() =>
          publish === 'publish'
            ? ctx.publish({ name, payload }, { meta })
            : ctx.publishInbound({ name, meta, payload }),
        );
        return yield* plane.awaitRunEnd('run-1');
      }).pipe(Effect.scoped),
    );

  test.each([
    'publish',
    'publishInbound',
  ] as const)("a proxy's %s decodes: agents and folds get the values, the store the same wire form", async (publish) => {
    const { network, received, folded, stored } = recording();

    await viaProxy(network, wire, publish);

    expect(received).toEqual([decoded]);
    expect(folded).toEqual([decoded]);
    expect(await stored('coded')).toEqual(wire);
  });

  test('a payload already of the type (e.g. relayed in process) is taken as it is', async () => {
    const { network, received, folded, stored } = recording();

    await viaProxy(network, decoded);

    expect(received).toEqual([decoded]);
    expect(folded).toEqual([decoded]);
    expect(await stored('coded')).toEqual(wire);
  });

  test('a string that is not valid encoded data is the decoded value: agents and folds agree', async () => {
    const { network, received, folded, stored } = recording(Strings);
    // Not base64, so it cannot be wire data: the only consistent reading is the value itself.
    const literal = { b64: '%%%', uri: 'a b' };

    await viaProxy(network, literal, 'publish', 'strings');

    expect(received).toEqual([literal]);
    expect(folded).toEqual([literal]);
    expect(await stored('strings')).toEqual({ b64: 'JSUl', uri: 'a%20b' });
  });

  test('a payload that is neither is published and stored as given; folds skip it', async () => {
    const { network, received, folded, stored } = recording(Strings);
    const broken = { b64: 42, uri: 'a%20b' };

    await viaProxy(network, broken, 'publish', 'strings');

    // As before for agents; the store keeps it as it came, and folds skip (and report) it.
    expect(received).toEqual([broken]);
    expect(await stored('strings')).toEqual(broken);
    expect(folded).toEqual([]);
  });

  describe('events made with make / makeBound are values, published as they are', () => {
    // As `make` returns it, decoded: the base64 of "test" and a URI-encoded "%20".
    const input = { b64: 'dGVzdA==', uri: 'a%2520b' };
    const value = { b64: 'test', uri: 'a%20b' };
    const meta = { runId: 'run-1', contextId: 'ctx' };
    type Publishers = {
      readonly ctx: Parameters<Parameters<typeof Inbound.register>[1]>[0];
      readonly api: ReturnType<AgentNetwork['expose']>;
    };

    /** Publishes with `publish` on a shared plane; resolves once the run ended. */
    const publishing = (network: AgentNetwork, publish: (on: Publishers) => Promise<unknown>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          let ctx!: Publishers['ctx'];
          network.expose(
            Inbound.register({ channel: 'main', plane }, (context) => {
              ctx = context;
              return context.createInteractiveStream({ plane, reconnectWindow: 0 });
            }),
          );
          const api = network.expose(registerSSEStream({ plane, reconnectWindow: 0 }));
          yield* Effect.promise(() => publish({ ctx, api }));
          return yield* plane.awaitRunEnd('run-1');
        }).pipe(Effect.scoped),
      );

    test.each<[string, (on: Publishers) => Promise<unknown>]>([
      ['api.publish(make)', ({ api }) => api.publish(Strings.make(input), { meta })],
      [
        'api.withMeta().publish(make)',
        ({ api }) => api.withMeta(meta).publish(Strings.make(input)),
      ],
      ['ctx.publish(make)', ({ ctx }) => ctx.publish(Strings.make(input), { meta })],
      [
        'ctx.publish(makeEffect)',
        ({ ctx }) => ctx.publish(Effect.runSync(Strings.makeEffect(input)), { meta }),
      ],
      [
        'ctx.publishInbound(makeBound)',
        ({ ctx }) => ctx.publishInbound(Strings.makeBound(meta, input)),
      ],
      [
        'ctx.publishInbound(makeBoundEffect)',
        ({ ctx }) => ctx.publishInbound(Effect.runSync(Strings.makeBoundEffect(meta, input))),
      ],
    ])('%s: agents and folds get the value, never decoded again', async (_label, publish) => {
      const { network, received, folded, stored } = recording(Strings);

      await publishing(network, publish);

      expect(received).toEqual([value]);
      expect(folded).toEqual([value]);
      expect(await stored('strings')).toEqual(input);
    });

    test('a copy of a made event is data from outside again: decoded as wire data', async () => {
      const { network, received } = recording(Strings);

      await publishing(network, ({ ctx }) => ctx.publish({ ...Strings.make(input) }, { meta }));

      // "test" read as base64, "a%20b" as URI-encoded: the wire rule, for an object of unknown origin.
      expect(received).toEqual([{ b64: Buffer.from('test', 'base64').toString(), uri: 'a b' }]);
    });
  });

  test('a request body is wire data too: the start event is decoded, not taken as it is', async () => {
    const { network, received, folded, stored } = recording(Strings);
    const api = network.expose(registerSSEStream({ triggerEvents: [Strings] }));

    await api.createStream(
      { request: post({ b64: 'aGk=', uri: 'a%20b' }), contextId: 'ctx', runId: 'run-1' },
      async (stream) => {
        for await (const _ of stream);
      },
    );

    expect(received).toEqual([{ b64: 'hi', uri: 'a b' }]);
    expect(folded).toEqual([{ b64: 'hi', uri: 'a b' }]);
    expect(await stored('strings')).toEqual({ b64: 'aGk=', uri: 'a%20b' });
  });
});
