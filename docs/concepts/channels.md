# Channels (Routing)

Channels are named conduits for events. They route events between agents and connect to external systems via **sinks**.

## Creating Channels

```ts
const network = AgentNetwork.setup(({ mainChannel, createChannel, sink }) => {
  // The main channel — where start events are published
  const main = mainChannel('main');

  // Additional channels
  const processing = createChannel('processing');
  const client = createChannel('client');
});
```

Channel names must be **kebab-case** (e.g. `'main'`, `'client-output'`, `'processing-queue'`). This is enforced at runtime with a branded type.

## Channel Events

You can optionally declare which events a channel carries:

```ts
const client = createChannel('client')
  .events([responseEvent, errorEvent]);
```

## Sinks

Sinks determine how events leave a channel. They are the bridge between the internal event plane and external systems.

### HTTP Stream Sink

Routes events to HTTP SSE streams. Required for `expose()` to work.

```ts
const client = createChannel('client').sink(sink.httpStream());
```

### Kafka Sink

Routes events to a Kafka topic.

```ts
const events = createChannel('events').sink(sink.kafka({ topic: 'agent-events' }));
```

### Multiple Sinks

A single channel can have multiple sinks:

```ts
const output = createChannel('output')
  .sink(sink.httpStream())
  .sink(sink.kafka({ topic: 'output-events' }));
```

## Event Flow

1. A **start event** is published to the main channel (either programmatically or via `expose()`)
2. Agents subscribed to that channel **receive the event** (filtered by their `listensTo` declarations)
3. Agent logic runs and **emits new events**
4. Emitted events are published to the agent's **publishTo channels**
5. Other agents on those channels pick up the events, continuing the chain
6. Events on channels with an **HTTP stream sink** are streamed to the client

```text
Start Event → Main Channel → Agent A → Processing Channel → Agent B → Client Channel → SSE
```

See [Channel API](../api-reference/channel-api.md) for full reference.
