# AgentNetwork

The `AgentNetwork` orchestrates agents, channels, and the event plane. Use `AgentNetwork.setup()` to wire everything together.

## Setup

```ts
const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, sink, registerAgent, spawner }) => {
    // ...
  },
);
```

## Setup Context

### `mainChannel(name)`

Creates and designates the **main channel**. Start events are published here when the network is exposed as an API. Every network should have exactly one main channel.

```ts
const main = mainChannel('main');
```

### `createChannel(name)`

Creates an additional named channel. Names must be kebab-case.

```ts
const client = createChannel('client');
const analytics = createChannel('analytics');
```

### `sink`

Provides sink factories:

```ts
const client = createChannel('client').sink(sink.httpStream());
const events = createChannel('events').sink(sink.kafka({ topic: 'events' }));
```

### `registerAgent(agent)`

Registers an agent and returns a binding builder:

```ts
registerAgent(myAgent)
  .subscribe(main)
  .publishTo(client);
```

An agent can subscribe to and publish to multiple channels:

```ts
registerAgent(routerAgent)
  .subscribe(main)
  .subscribe(feedback)
  .publishTo(client)
  .publishTo(analytics);
```

### `spawner`

Creates a spawner for dynamically creating agents at runtime (multi-tenant, on-demand):

```ts
spawner(AgentFactory)
  .listen(main, spawnEvent)
  .registry({ analyst: analystFactory, writer: writerFactory })
  .defaultBinding(({ kind }) => ({ subscribe: ['main'], publishTo: ['client'] }))
  .onSpawn(({ kind, factory, payload, spawn }) => {
    const agent = factory.produce(payload.params);
    spawn(agent);
    return agent;
  });
```

## Running the Network

### HTTP API (recommended)

```ts
const api = network.expose({
  protocol: 'sse',
  select: { channels: 'client' },
  startEventName: 'user-request',
});
```

See [IO + Adapters](io-adapters.md).

### Programmatic Run

```ts
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const plane = yield* network.run();
      // publish events, wait for results...
    }),
  ),
);
```

## Accessors

```ts
network.getChannels();             // Map<ChannelName, ConfiguredChannel>
network.getMainChannel();          // ConfiguredChannel | undefined
network.getAgentRegistrations();   // Map<string, AgentRegistration>
network.getSpawnerRegistrations(); // ReadonlyArray<SpawnerRegistration>
```

## See Also

- [Networks (Concepts)](../concepts/networks.md)
- [Patterns](../guides/patterns.md)
- [IO + Adapters](io-adapters.md)
