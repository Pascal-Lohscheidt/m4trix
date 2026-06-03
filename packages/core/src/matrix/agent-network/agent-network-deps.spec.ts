import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { DepedencyLayer } from '../dependency-layer.js';
import { AgentNetwork } from './agent-network.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import { ChannelName } from './channel.js';

describe('AgentNetwork dependency layers', () => {
  const pingEvent = AgentNetworkEvent.of('ping', S.Struct({ n: S.Number }));
  const pongEvent = AgentNetworkEvent.of('pong', S.Struct({ n: S.Number }));

  const openAiLayer = DepedencyLayer.of({
    name: 'OpenAi',
    config: S.Struct({ model: S.String }),
  }).define<{
    client: { chat: { completions: { create: (opts: unknown) => Promise<unknown> } } };
  }>();

  const dbLayer = DepedencyLayer.of({
    name: 'Db',
    config: S.Struct({}),
  }).define<{ pool: { query: (sql: string) => Promise<unknown> } }>();

  test('registers agent when network declares matching dependencies', () => {
    const agent = AgentFactory.run()
      .dependsOn(openAiLayer)
      .listensTo([pingEvent])
      .emits([pongEvent])
      .logic(async () => {})
      .produce({});

    expect(() =>
      AgentNetwork.dependsOn(openAiLayer).setup(({ mainChannel, registerAgent }) => {
        registerAgent(agent).subscribe(mainChannel);
      }),
    ).not.toThrow();
  });

  test('setup preserves dependency type inference', () => {
    const network = AgentNetwork.dependsOn(openAiLayer).setup(() => {});

    expectTypeOf(network).toEqualTypeOf<AgentNetwork<typeof openAiLayer>>();
  });

  test('throws dependency mismatch when registering agent', () => {
    const agent = AgentFactory.run()
      .dependsOn(openAiLayer)
      .logic(async () => {})
      .produce({});

    expect(() =>
      AgentNetwork.dependsOn(dbLayer).setup(({ mainChannel, registerAgent }) => {
        registerAgent(agent).subscribe(mainChannel);
      }),
    ).toThrow('Dependency mismatch for agent');
  });

  test('throws when run is missing required layer injection', () => {
    const network = AgentNetwork.dependsOn(openAiLayer).setup(({ mainChannel, registerAgent }) => {
      const agent = AgentFactory.run()
        .dependsOn(openAiLayer)
        .listensTo([pingEvent])
        .logic(async () => {})
        .produce({});
      registerAgent(agent).subscribe(mainChannel);
    });

    expect(() => network.run()).toThrow(
      'Network run requires layers injection for declared dependencies',
    );
  });

  test('injects layers into agent logic during run', async () => {
    const createSpy = vi.fn(async () => ({ choices: [{ message: { content: 'ok' } }] }));

    const agent = AgentFactory.run()
      .dependsOn(openAiLayer)
      .listensTo([pingEvent])
      .emits([pongEvent])
      .logic(async ({ layers, emit, triggerEvent }) => {
        expectTypeOf(layers.OpenAi.config.model).toEqualTypeOf<string>();
        await layers.OpenAi.client.chat.completions.create({
          model: layers.OpenAi.config.model,
          messages: [{ role: 'user', content: String(triggerEvent.payload.n) }],
        });
        emit({ name: 'pong', payload: { n: triggerEvent.payload.n + 1 } });
      })
      .produce({});

    const network = AgentNetwork.dependsOn(openAiLayer).setup(({ mainChannel, registerAgent }) => {
      registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
    });
    const openAiInstance = openAiLayer.make({
      client: {
        chat: {
          completions: {
            create: createSpy,
          },
        },
      },
      config: { model: 'gpt-4o' },
    });
    const typeOnly = false as boolean;

    if (typeOnly) {
      network.run({
        layers: {
          // @ts-expect-error - runtime layers must be constructed with layer.make(...)
          OpenAi: {
            client: {
              chat: {
                completions: {
                  create: createSpy,
                },
              },
            },
            config: { model: 'gpt-4o' },
          },
        },
      });
    }

    const program = network
      .run({
        layers: {
          OpenAi: openAiInstance,
        },
      })
      .pipe(
        Effect.flatMap((plane) =>
          Effect.gen(function* () {
            yield* Effect.sleep('10 millis');
            yield* plane.publish(ChannelName('main'), {
              name: 'ping',
              meta: { runId: 'run-1', contextId: 'ctx-1' },
              payload: { n: 1 },
            });
            yield* Effect.sleep('50 millis');
            return plane.getRunEvents('run-1', 'ctx-1');
          }),
        ),
      );

    const events = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(createSpy).toHaveBeenCalledWith({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '1' }],
    });
    expect(
      events.some((event) => event.name === 'pong' && (event.payload as { n: number }).n === 2),
    ).toBe(true);
  });

  test('network without dependencies still runs without layer injection', async () => {
    const agent = AgentFactory.run()
      .listensTo([pingEvent])
      .emits([pongEvent])
      .logic(async ({ emit, triggerEvent }) => {
        emit({ name: 'pong', payload: { n: triggerEvent.payload.n + 1 } });
      })
      .produce({});

    const network = AgentNetwork.setup(({ mainChannel, registerAgent }) => {
      registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
    });

    const program = network.run().pipe(
      Effect.flatMap((plane) =>
        Effect.gen(function* () {
          yield* Effect.sleep('10 millis');
          yield* plane.publish(ChannelName('main'), {
            name: 'ping',
            meta: { runId: 'run-1', contextId: 'ctx-1' },
            payload: { n: 3 },
          });
          yield* Effect.sleep('50 millis');
          return plane.getRunEvents('run-1', 'ctx-1');
        }),
      ),
    );

    const events = await Effect.runPromise(program.pipe(Effect.scoped));
    expect(
      events.some((event) => event.name === 'pong' && (event.payload as { n: number }).n === 4),
    ).toBe(true);
  });
});
