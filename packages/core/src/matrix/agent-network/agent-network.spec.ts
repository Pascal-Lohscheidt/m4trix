import { Effect, Queue, Schema as S } from 'effect';
import { describe, expect, test, vitest } from 'vitest';
import { AgentFactory } from '../agent-factory';
import { AgentNetwork } from './agent-network';
import type { EventMeta } from './agent-network-event';
import { AgentNetworkEvent } from './agent-network-event';
import { ChannelName } from './channel';
import { EventAggregator } from './event-aggregator';

describe('AgentNetwork', () => {
  describe('setup - channels', () => {
    test('creates a main channel and additional channels', () => {
      const network = AgentNetwork.setup(({ createChannel }) => {
        createChannel('client');
      });

      expect(network.getChannels().size).toBe(2);
      expect(network.getMainChannel()?.name).toBe('main');
      expect(network.getChannels().has('client')).toBe(true);
    });

    test('channels can be configured with events and sinks', () => {
      const weatherSet = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));

      const network = AgentNetwork.setup(({ mainChannel, sink }) => {
        const main = mainChannel
          .events([weatherSet])
          .sink(sink.kafka({ topic: 'main' }));

        expect(main.getEvents()).toHaveLength(1);
        expect(main.getEvents()[0]?.name).toBe('weather-set');
        expect(main.getSinks()).toEqual([
          {
            _tag: 'SinkDef',
            type: 'kafka',
            config: { topic: 'main' },
          },
        ]);
      });

      expect(network.getChannels().size).toBe(1);
    });

    test('httpStream sink can be assigned to a channel', () => {
      const network = AgentNetwork.setup(({ createChannel, sink }) => {
        const client = createChannel('client').sink(sink.httpStream());

        expect(client.getSinks()).toEqual([
          {
            _tag: 'SinkDef',
            type: 'http-stream',
            config: {},
          },
        ]);
      });

      expect(network.getChannels().size).toBe(2);
    });
  });

  describe('setup - registerAgent', () => {
    test('registers a static agent with subscribe and publishTo', () => {
      const agent = AgentFactory.run()
        .logic(() => Promise.resolve())
        .produce({});

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');

        registerAgent(agent).subscribe(main).publishTo(client);
      });

      const registrations = network.getAgentRegistrations();
      expect(registrations.size).toBe(1);

      const [reg] = [...registrations.values()];
      expect(reg!.subscribedTo).toHaveLength(1);
      expect(reg!.subscribedTo[0]!.name).toBe('main');
      expect(reg!.publishesTo).toHaveLength(1);
      expect(reg!.publishesTo[0]!.name).toBe('client');
    });

    test('supports subscribing to multiple channels', () => {
      const agent = AgentFactory.run()
        .logic(() => Promise.resolve())
        .produce({});

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const logs = createChannel('logs');

        registerAgent(agent).subscribe(main).subscribe(logs);
      });

      const [reg] = [...network.getAgentRegistrations().values()];
      expect(reg!.subscribedTo).toHaveLength(2);
      expect(reg!.subscribedTo.map((c) => c.name)).toEqual(['main', 'logs']);
    });

    test('defines store at setup time, shared across event planes', async () => {
      const evt = AgentNetworkEvent.of('ping', S.Struct({ n: S.Number }));
      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');
        const agent = AgentFactory.run()
          .listensTo([evt])
          .emits([evt])
          .logic(async ({ triggerEvent, emit }) => {
            emit({
              name: 'ping',
              payload: { n: triggerEvent.payload.n + 1 },
            });
          })
          .produce({});
        registerAgent(agent).subscribe(main).publishTo(client);
      });

      const store = network.getStore();
      expect(store).toBeDefined();
      expect(store.getEvents('ctx', 'run')).toEqual([]);

      const program = network.run().pipe(
        Effect.flatMap((plane) =>
          Effect.gen(function* () {
            yield* Effect.sleep('10 millis');
            yield* plane.publish(ChannelName('main'), {
              name: 'ping',
              meta: { runId: 'run-1', contextId: 'ctx-1' },
              payload: { n: 0 },
            });
            yield* Effect.sleep('50 millis');
            return { plane, store: network.getStore() };
          }),
        ),
      );

      const { plane, store: storeAfter } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(storeAfter).toBe(store);
      const events = plane.getRunEvents('run-1', 'ctx-1');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toMatchObject({ name: 'ping', payload: { n: 0 } });
    });
  });

  describe('setup - registerAggregator', () => {
    test('registers an event aggregator with subscribe and publishTo', () => {
      const trigger = AgentNetworkEvent.of('trigger', S.Struct({ text: S.String }));
      const aggregated = AgentNetworkEvent.of('aggregated', S.Struct({ text: S.String }));
      const aggregator = EventAggregator.listensTo([trigger])
        .emits([aggregated])
        .mapToEmit(({ triggerEvent, emit }) => {
          emit(aggregated.make({ text: triggerEvent.payload.text }));
        });

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAggregator }) => {
        const main = mainChannel;
        const client = createChannel('client');

        registerAggregator(aggregator).subscribe(main).publishTo(client);
      });

      const registrations = network.getAgentRegistrations();
      expect(registrations.size).toBe(1);

      const [reg] = [...registrations.values()];
      expect(reg!.subscribedTo).toHaveLength(1);
      expect(reg!.subscribedTo[0]!.name).toBe('main');
      expect(reg!.publishesTo).toHaveLength(1);
      expect(reg!.publishesTo[0]!.name).toBe('client');
    });
  });

  describe('setup - spawner', () => {
    test('configures a spawner with listen, registry, defaultBinding, and onSpawn', () => {
      const spawnEvent = AgentNetworkEvent.of('daemon-spawn', S.Struct({ kind: S.String }));
      const weatherEvent = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));

      const WeatherFactory = AgentFactory.run()
        .listensTo([weatherEvent])
        .logic(() => Promise.resolve());

      const defaultBindingSpy = vitest.fn(({ kind }: { kind: string }) => ({
        subscribe: ['main'],
        publishTo: kind === 'Weather' ? ['client'] : [],
      }));

      const onSpawnSpy = vitest.fn();

      const network = AgentNetwork.setup(({ mainChannel, createChannel, spawner }) => {
        const main = mainChannel;
        createChannel('client');

        spawner(AgentFactory)
          .listen(main, spawnEvent)
          .registry({ Weather: WeatherFactory as AgentFactory })
          .defaultBinding(defaultBindingSpy)
          .onSpawn(onSpawnSpy);
      });

      const spawners = network.getSpawnerRegistrations();
      expect(spawners).toHaveLength(1);
      expect(spawners[0]!.listenChannel?.name).toBe('main');
      expect(spawners[0]!.listenEvent?.name).toBe('daemon-spawn');
      expect(spawners[0]!.registry).toHaveProperty('Weather');
    });
  });

  describe('full setup - mirrors target API', () => {
    test('complete network definition with channels, agents, and spawner', () => {
      const daemon_spawn = AgentNetworkEvent.of('daemon-spawn', S.Struct({ kind: S.String }));
      const weather_set = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));
      const weather_forecast_created = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const WeatherFactory = AgentFactory.run()
        .listensTo([weather_set])
        .emits([weather_forecast_created])
        .logic(() => Promise.resolve());

      const AirplaneControlFactory = AgentFactory.run().logic(() => Promise.resolve());

      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, sink, registerAgent, spawner }) => {
          // 1) channels
          const main = mainChannel
            .events([daemon_spawn, weather_set, weather_forecast_created])
            .sink(sink.kafka({ topic: 'main' }));

          const client = createChannel('client')
            .events([weather_forecast_created])
            .sink(sink.httpStream());

          // 2) static agents
          const weatherAgent = WeatherFactory.produce({});
          registerAgent(weatherAgent).subscribe(main).publishTo(client);

          // 3) spawner
          spawner(AgentFactory)
            .listen(main, daemon_spawn)
            .registry({
              Weather: WeatherFactory as AgentFactory,
              AirplaneControl: AirplaneControlFactory as AgentFactory,
            })
            .defaultBinding(({ kind }) => ({
              subscribe: ['main'],
              publishTo: kind === 'Weather' ? ['client'] : [],
            }))
            .onSpawn(({ factory, payload, spawn }) => {
              const agent = (factory as AgentFactory).produce({
                ...payload.params,
              });
              spawn(agent, {
                subscribe: payload.subscribe,
                publishTo: payload.publishTo,
              });
              return agent;
            });
        },
      );

      // Verify the full setup
      expect(network.getChannels().size).toBe(2);
      expect(network.getMainChannel()?.name).toBe('main');
      expect(network.getAgentRegistrations().size).toBe(1);
      expect(network.getSpawnerRegistrations()).toHaveLength(1);
    });
  });

  describe('event plane integration', () => {
    test('agents subscribed to a channel are invoked when matching events are published', async () => {
      const weatherSet = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));
      const weatherForecast = AgentNetworkEvent.of(
        'weather-forecast-created',
        S.Struct({ forecast: S.String }),
      );

      const logicSpy = vitest.fn<
        [
          {
            triggerEvent: {
              name: string;
              meta: EventMeta;
              payload: { temp: number };
            };
            emit: (e: unknown) => void;
          },
        ],
        Promise<void>
      >(async ({ triggerEvent, emit }) => {
        emit({
          name: 'weather-forecast-created',
          payload: { forecast: `Temp was ${triggerEvent.payload.temp}` },
        });
      });

      const WeatherAgent = AgentFactory.run()
        .listensTo([weatherSet])
        .emits([weatherForecast])
        // biome-ignore lint/suspicious/noExplicitAny: needed for builder pattern
        .logic(logicSpy as any);

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');
        const agent = WeatherAgent.produce({});
        registerAgent(agent).subscribe(main).publishTo(client);
      });

      const meta = { runId: 'test-run', contextId: 'test-context' } as const;

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

      const { emitted, logicSpy: spy } = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(emitted).toMatchObject({
        name: 'weather-forecast-created',
        payload: { forecast: 'Temp was 22' },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerEvent: expect.objectContaining({
            name: 'weather-set',
            payload: { temp: 22 },
          }),
        }),
      );
    });

    test('agents are NOT invoked when event does not match listensTo', async () => {
      const weatherSet = AgentNetworkEvent.of('weather-set', S.Struct({ temp: S.Number }));

      const logicSpy = vitest.fn().mockResolvedValue(undefined);

      const WeatherAgent = AgentFactory.run().listensTo([weatherSet]).logic(logicSpy);

      const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
        const main = mainChannel;
        const client = createChannel('client');
        const agent = WeatherAgent.produce({});
        registerAgent(agent).subscribe(main).publishTo(client);
      });

      const meta = { runId: 'test-run', contextId: 'test-context' } as const;

      const program = Effect.gen(function* () {
        const plane = yield* network.run();
        const mainCh = network.getMainChannel()!;

        yield* Effect.sleep('10 millis');

        yield* plane.publish(mainCh.name, {
          name: 'other-event',
          meta,
          payload: { value: 'ignored' },
        });

        yield* Effect.sleep('20 millis');

        return logicSpy;
      });

      const spy = await Effect.runPromise(program.pipe(Effect.scoped));

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
