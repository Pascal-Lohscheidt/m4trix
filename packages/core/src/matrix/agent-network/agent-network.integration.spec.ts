import { describe, expect, test, vitest } from 'vitest';
import { Effect, Queue } from 'effect';
import { Schema as S } from 'effect';
import type { EventMeta } from './agent-network-event';
import { AgentNetwork } from './agent-network';
import { AgentNetworkEvent } from './agent-network-event';
import { AgentFactory } from '../agent-factory';
import { ChannelName } from './channel';

// Define meta with contextId to fix linter error
const meta: EventMeta = { runId: 'test-run', contextId: 'test-context' };

async function takeFirst(stream: AsyncIterable<unknown>): Promise<unknown> {
  for await (const e of stream) return e;
  return undefined;
}

describe('AgentNetwork integration', () => {
  describe('single agent flow', () => {
    test('agent receives event, processes, and emits to output channel', async () => {
      const weatherSet = AgentNetworkEvent.of(
        'weather-set',
        S.Struct({ temp: S.Number }),
      );
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const logicSpy = vitest.fn(
        async ({
          triggerEvent,
          emit,
        }: {
          triggerEvent: { meta: EventMeta; payload: { temp: number } };
          emit: (e: unknown) => void;
        }) => {
          emit({
            name: 'weather-forecast-created',
            meta: triggerEvent.meta,
            payload: { forecast: `Temp was ${triggerEvent.payload.temp}` },
          });
        },
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client');
          registerAgent(
            AgentFactory.run()
              .listensTo([weatherSet])
              .emits([weatherForecast])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .logic(logicSpy as any)
              .produce({}),
          )
            .subscribe(main)
            .publishTo(client);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;
        const clientCh = network.getChannels().get('client')!;

        yield* Effect.sleep('10 millis');

        const clientDequeue = yield* plane.subscribe(clientCh.name);
        yield* plane.publish(mainCh.name, {
          name: 'weather-set',
          meta,
          payload: { temp: 22 },
        });

        const emitted = yield* Queue.take(clientDequeue);
        return { emitted, logicSpy };
      });

      const { emitted, logicSpy: spy } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(emitted).toMatchObject({
        name: 'weather-forecast-created',
        payload: { forecast: 'Temp was 22' },
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('multiple agents on same channel', () => {
    test('each agent receives only events it listens to', async () => {
      const weatherSet = AgentNetworkEvent.of(
        'weather-set',
        S.Struct({ temp: S.Number }),
      );
      const orderPlaced = AgentNetworkEvent.of(
        'order-placed',
        S.Struct({ orderId: S.String }),
      );
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );
      const orderConfirmed = AgentNetworkEvent.of(
        'order-confirmed',
        S.Struct({ orderId: S.String }),
      );

      const weatherSpy = vitest.fn(
        async ({
          triggerEvent,
          emit,
        }: {
          triggerEvent: { meta: EventMeta; payload: { temp: number } };
          emit: (e: unknown) => void;
        }) => {
          emit({
            name: 'weather-forecast-created',
            meta: triggerEvent.meta,
            payload: { forecast: `Temp ${triggerEvent.payload.temp}` },
          });
        },
      );

      const orderSpy = vitest.fn(
        async ({
          triggerEvent,
          emit,
        }: {
          triggerEvent: { meta: EventMeta; payload: { orderId: string } };
          emit: (e: unknown) => void;
        }) => {
          emit({
            name: 'order-confirmed',
            meta: triggerEvent.meta,
            payload: { orderId: triggerEvent.payload.orderId },
          });
        },
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const weatherOut = createChannel('weather-out');
          const orderOut = createChannel('order-out');

          registerAgent(
            AgentFactory.run()
              .listensTo([weatherSet])
              .emits([weatherForecast])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .logic(weatherSpy as any)
              .produce({}),
          )
            .subscribe(main)
            .publishTo(weatherOut);

          registerAgent(
            AgentFactory.run()
              .listensTo([orderPlaced])
              .emits([orderConfirmed])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .logic(orderSpy as any)
              .produce({}),
          )
            .subscribe(main)
            .publishTo(orderOut);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;
        const weatherOutCh = network.getChannels().get('weather-out')!;
        const orderOutCh = network.getChannels().get('order-out')!;

        yield* Effect.sleep('10 millis');

        const weatherDequeue = yield* plane.subscribe(weatherOutCh.name);
        const orderDequeue = yield* plane.subscribe(orderOutCh.name);

        yield* plane.publish(mainCh.name, {
          name: 'weather-set',
          meta,
          payload: { temp: 15 },
        });
        yield* plane.publish(mainCh.name, {
          name: 'order-placed',
          meta,
          payload: { orderId: 'ord-123' },
        });

        const [weatherEmitted, orderEmitted] = yield* Effect.all([
          Queue.take(weatherDequeue),
          Queue.take(orderDequeue),
        ]);

        return {
          weatherEmitted,
          orderEmitted,
          weatherSpy,
          orderSpy,
        };
      });

      const result = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(result.weatherEmitted).toMatchObject({
        name: 'weather-forecast-created',
        payload: { forecast: 'Temp 15' },
      });
      expect(result.orderEmitted).toMatchObject({
        name: 'order-confirmed',
        payload: { orderId: 'ord-123' },
      });
      expect(result.weatherSpy).toHaveBeenCalledTimes(1);
      expect(result.orderSpy).toHaveBeenCalledTimes(1);
    });

    test('agent listening to multiple events receives each matching event', async () => {
      const eventA = AgentNetworkEvent.of('event-a', S.Struct({ a: S.Number }));
      const eventB = AgentNetworkEvent.of('event-b', S.Struct({ b: S.String }));
      const resultEvent = AgentNetworkEvent.of(
        'result',
        S.Struct({ value: S.String }),
      );

      const multiSpy = vitest.fn(
        async ({
          triggerEvent,
          emit,
        }: {
          triggerEvent: { name: string; meta: EventMeta; payload: unknown };
          emit: (e: unknown) => void;
        }) => {
          const value =
            triggerEvent.name === 'event-a'
              ? `a:${(triggerEvent.payload as { a: number }).a}`
              : `b:${(triggerEvent.payload as { b: string }).b}`;
          emit({
            name: 'result',
            meta: triggerEvent.meta,
            payload: { value },
          });
        },
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const out = createChannel('out');
          registerAgent(
            AgentFactory.run()
              .listensTo([eventA, eventB])
              .emits([resultEvent])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .logic(multiSpy as any)
              .produce({}),
          )
            .subscribe(main)
            .publishTo(out);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;
        const outCh = network.getChannels().get('out')!;

        yield* Effect.sleep('10 millis');

        const outDequeue = yield* plane.subscribe(outCh.name);

        yield* plane.publish(mainCh.name, {
          name: 'event-a',
          meta,
          payload: { a: 42 },
        });
        yield* plane.publish(mainCh.name, {
          name: 'event-b',
          meta,
          payload: { b: 'hello' },
        });

        const [first, second] = yield* Effect.all([
          Queue.take(outDequeue),
          Queue.take(outDequeue),
        ]);

        return { first, second, multiSpy };
      });

      const {
        first,
        second,
        multiSpy: multiSpyResult,
      } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(first).toMatchObject({
        name: 'result',
        payload: { value: 'a:42' },
      });
      expect(second).toMatchObject({
        name: 'result',
        payload: { value: 'b:hello' },
      });
      expect(multiSpyResult).toHaveBeenCalledTimes(2);
    });
  });

  describe('agent chain', () => {
    test('event flows through multiple agents in sequence', async () => {
      const taskCreated = AgentNetworkEvent.of(
        'task-created',
        S.Struct({ title: S.String }),
      );
      const taskEnriched = AgentNetworkEvent.of(
        'task-enriched',
        S.Struct({ title: S.String, slug: S.String }),
      );
      const taskFinalized = AgentNetworkEvent.of(
        'task-finalized',
        S.Struct({ title: S.String, slug: S.String, id: S.String }),
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const enriched = createChannel('enriched');
          const finalized = createChannel('finalized');

          registerAgent(
            AgentFactory.run()
              .listensTo([taskCreated])
              .emits([taskEnriched])
              .logic(async ({ triggerEvent, emit }) => {
                const p = triggerEvent.payload as { title: string };
                emit({
                  name: 'task-enriched',
                  payload: {
                    title: p.title,
                    slug: p.title.toLowerCase().replace(/\s+/g, '-'),
                  },
                });
              })
              .produce({}),
          )
            .subscribe(main)
            .publishTo(enriched);

          registerAgent(
            AgentFactory.run()
              .listensTo([taskEnriched])
              .emits([taskFinalized])
              .logic(async ({ triggerEvent, emit }) => {
                const p = triggerEvent.payload as {
                  title: string;
                  slug: string;
                };
                emit({
                  name: 'task-finalized',
                  payload: {
                    ...p,
                    id: `task-${p.slug}`,
                  },
                });
              })
              .produce({}),
          )
            .subscribe(enriched)
            .publishTo(finalized);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;
        const finalizedCh = network.getChannels().get('finalized')!;

        yield* Effect.sleep('10 millis');

        const finalizedDequeue = yield* plane.subscribe(finalizedCh.name);

        yield* plane.publish(mainCh.name, {
          name: 'task-created',
          meta,
          payload: { title: 'Hello World' },
        });

        const result = yield* Queue.take(finalizedDequeue);
        return result;
      });

      const result = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(result).toMatchObject({
        name: 'task-finalized',
        payload: {
          title: 'Hello World',
          slug: 'hello-world',
          id: 'task-hello-world',
        },
      });
    });
  });

  describe('agent subscribed to multiple channels', () => {
    test('agent receives events from all subscribed channels', async () => {
      const mainEvent = AgentNetworkEvent.of(
        'main-event',
        S.Struct({ from: S.Literal('main') }),
      );
      const logsEvent = AgentNetworkEvent.of(
        'logs-event',
        S.Struct({ from: S.Literal('logs') }),
      );
      const combined = AgentNetworkEvent.of(
        'combined',
        S.Struct({ source: S.String }),
      );

      const combinedSpy = vitest.fn(
        async ({
          triggerEvent,
          emit,
        }: {
          triggerEvent: { name: string; meta: EventMeta; payload: unknown };
          emit: (e: unknown) => void;
        }) => {
          const source = triggerEvent.name === 'main-event' ? 'main' : 'logs';
          emit({
            name: 'combined',
            meta: triggerEvent.meta,
            payload: { source },
          });
        },
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const logs = createChannel('logs');
          const out = createChannel('out');

          registerAgent(
            AgentFactory.run()
              .listensTo([mainEvent, logsEvent])
              .emits([combined])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .logic(combinedSpy as any)
              .produce({}),
          )
            .subscribe(main)
            .subscribe(logs)
            .publishTo(out);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;
        const logsCh = network.getChannels().get('logs')!;
        const outCh = network.getChannels().get('out')!;

        yield* Effect.sleep('10 millis');

        const outDequeue = yield* plane.subscribe(outCh.name);

        yield* plane.publish(mainCh.name, {
          name: 'main-event',
          meta,
          payload: { from: 'main' },
        });
        yield* plane.publish(logsCh.name, {
          name: 'logs-event',
          meta,
          payload: { from: 'logs' },
        });

        const [fromMain, fromLogs] = yield* Effect.all([
          Queue.take(outDequeue),
          Queue.take(outDequeue),
        ]);

        return { fromMain, fromLogs, combinedSpy };
      });

      const {
        fromMain,
        fromLogs,
        combinedSpy: combinedSpyResult,
      } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(fromMain).toMatchObject({
        name: 'combined',
        payload: { source: 'main' },
      });
      expect(fromLogs).toMatchObject({
        name: 'combined',
        payload: { source: 'logs' },
      });
      expect(combinedSpyResult).toHaveBeenCalledTimes(2);
    });
  });

  describe('agent without listensTo', () => {
    test('agent receives all events when listensTo is empty', async () => {
      const resultEvent = AgentNetworkEvent.of(
        'result',
        S.Struct({ received: S.String }),
      );

      const catchAllSpy = vitest.fn(
        async ({
          triggerEvent,
          emit,
        }: {
          triggerEvent: { name: string; meta: EventMeta; payload: unknown };
          emit: (e: unknown) => void;
        }) => {
          const received =
            triggerEvent.name === 'any-event'
              ? `num:${(triggerEvent.payload as { value: number }).value}`
              : `str:${(triggerEvent.payload as { x: string }).x}`;
          emit({
            name: 'result',
            meta: triggerEvent.meta,
            payload: { received },
          });
        },
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const out = createChannel('out');
          registerAgent(
            AgentFactory.run()
              .emits([resultEvent])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .logic(catchAllSpy as any)
              .produce({}),
          )
            .subscribe(main)
            .publishTo(out);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;
        const outCh = network.getChannels().get('out')!;

        yield* Effect.sleep('10 millis');

        const outDequeue = yield* plane.subscribe(outCh.name);

        yield* plane.publish(mainCh.name, {
          name: 'any-event',
          meta,
          payload: { value: 99 },
        });
        yield* plane.publish(mainCh.name, {
          name: 'other-event',
          meta,
          payload: { x: 'foo' },
        });

        const [first, second] = yield* Effect.all([
          Queue.take(outDequeue),
          Queue.take(outDequeue),
        ]);

        return { first, second, catchAllSpy };
      });

      const {
        first,
        second,
        catchAllSpy: catchAllSpyResult,
      } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(first).toMatchObject({
        name: 'result',
        payload: { received: 'num:99' },
      });
      expect(second).toMatchObject({
        name: 'result',
        payload: { received: 'str:foo' },
      });
      expect(catchAllSpyResult).toHaveBeenCalledTimes(2);
    });
  });

  describe('multiple events in sequence', () => {
    test('agents process multiple published events in order', async () => {
      const tick = AgentNetworkEvent.of('tick', S.Struct({ n: S.Number }));
      const tock = AgentNetworkEvent.of('tock', S.Struct({ n: S.Number }));

      const counterSpy = vitest.fn(
        async ({
          triggerEvent,
          emit,
        }: {
          triggerEvent: { meta: EventMeta; payload: { n: number } };
          emit: (e: unknown) => void;
        }) => {
          emit({
            name: 'tock',
            meta: triggerEvent.meta,
            payload: { n: triggerEvent.payload.n + 1 },
          });
        },
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const main = mainChannel('main');
          const out = createChannel('out');
          registerAgent(
            AgentFactory.run()
              .listensTo([tick])
              .emits([tock])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .logic(counterSpy as any)
              .produce({}),
          )
            .subscribe(main)
            .publishTo(out);
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;
        const outCh = network.getChannels().get('out')!;

        yield* Effect.sleep('10 millis');

        const outDequeue = yield* plane.subscribe(outCh.name);

        for (let i = 0; i < 5; i++) {
          yield* plane.publish(mainCh.name, {
            name: 'tick',
            meta,
            payload: { n: i },
          });
        }

        const results: unknown[] = [];
        for (let i = 0; i < 5; i++) {
          results.push(yield* Queue.take(outDequeue));
        }

        return { results, counterSpy };
      });

      const { results, counterSpy: counterSpyResult } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(results).toHaveLength(5);
      expect(results[0]).toMatchObject({ name: 'tock', payload: { n: 1 } });
      expect(results[4]).toMatchObject({ name: 'tock', payload: { n: 5 } });
      expect(counterSpyResult).toHaveBeenCalledTimes(5);
    });
  });

  describe('http-stream sink', () => {
    test('events on channel with http-stream sink are exposed to stream', async () => {
      const weatherSet = AgentNetworkEvent.of(
        'weather-set',
        S.Struct({ temp: S.Number }),
      );
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent }) => {
          const main = mainChannel('main');
          const client = createChannel('client').sink(sink.httpStream());
          registerAgent(
            AgentFactory.run()
              .listensTo([weatherSet])
              .emits([weatherForecast])
              .logic(async ({ triggerEvent, emit }) => {
                emit({
                  name: 'weather-forecast-created',
                  payload: {
                    forecast: `Temp was ${(triggerEvent.payload as { temp: number }).temp}`,
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
        const mainCh = network.getMainChannel()!;

        yield* Effect.sleep('10 millis');

        const api = network.expose({
          protocol: 'sse',
          plane,
          select: { channels: ChannelName('client') },
        });

        yield* plane.publish(mainCh.name, {
          name: 'weather-set',
          meta,
          payload: { temp: 25 },
        });

        const received = yield* Effect.tryPromise(() =>
          api.createStream(
            { request: { signal: new AbortController().signal } as Request },
            (stream) => takeFirst(stream),
          ),
        );
        return received;
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'weather-forecast-created',
        payload: { forecast: 'Temp was 25' },
      });
    });

    test('resolveChannels prefers channels with http-stream sink when select.channels not set', async () => {
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink }) => {
          mainChannel('main');
          createChannel('a');
          createChannel('client').sink(sink.httpStream());
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const clientCh = network.getChannels().get('client')!;

        yield* Effect.sleep('10 millis');

        const api = network.expose({ protocol: 'sse', plane });

        yield* Effect.fork(
          Effect.sleep('20 millis').pipe(
            Effect.flatMap(() =>
              plane.publish(clientCh.name, {
                name: 'event-a',
                meta,
                payload: { value: 42 },
              }),
            ),
          ),
        );

        const envelope = yield* Effect.tryPromise(() =>
          api.createStream(
            { request: { signal: new AbortController().signal } as Request },
            (stream) => takeFirst(stream),
          ),
        );
        return { channel: clientCh.name, envelope };
      });

      const { channel, envelope } = await Effect.runPromise(
        program.pipe(Effect.scoped),
      );

      expect(channel).toBe('client');
      expect(envelope).toMatchObject({
        name: 'event-a',
        payload: { value: 42 },
      });
    });

    test('channel with multiple sinks including http-stream is exposed', async () => {
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink }) => {
          mainChannel('main');
          createChannel('out')
            .sink(sink.httpStream())
            .sink(sink.kafka({ topic: 'events' }));
        },
      );

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const outCh = network.getChannels().get('out')!;

        yield* Effect.sleep('10 millis');

        const api = network.expose({ protocol: 'sse', plane });

        yield* Effect.fork(
          Effect.sleep('20 millis').pipe(
            Effect.flatMap(() =>
              plane.publish(outCh.name, {
                name: 'tick',
                meta,
                payload: { n: 1 },
              }),
            ),
          ),
        );

        const received = yield* Effect.tryPromise(() =>
          api.createStream(
            { request: { signal: new AbortController().signal } as Request },
            (stream) => takeFirst(stream),
          ),
        );
        return received;
      });

      const received = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(received).toMatchObject({
        name: 'tick',
        payload: { n: 1 },
      });
    });
  });
});
