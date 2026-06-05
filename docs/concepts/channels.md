---
title: "Channels (Routing)"
---

Channels are named conduits for events. They route events between agents and connect to external systems via **proxies**.

## Creating Channels

```ts
const network = AgentNetwork.setup(({ mainChannel, createChannel, proxy }) => {
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

## Proxies

Proxies declare how events can cross the boundary between the internal event plane and external systems.

### SSE Proxy

Routes events to HTTP SSE streams. Required for `expose()` to work.

```ts
const client = createChannel('client').proxy(proxy.sse());
```

### Kafka Proxy

Declares that events can be routed to a Kafka topic. Runtime Kafka activation is implemented separately.

```ts
const events = createChannel('events').proxy(proxy.kafka({ topic: 'agent-events' }));
```

### Multiple Proxies

A single channel can have multiple proxies:

```ts
const output = createChannel('output')
  .proxy(proxy.sse())
  .proxy(proxy.kafka({ topic: 'output-events' }));
```

## Event Flow

1. A **start event** is published to the main channel (either programmatically or via `expose()`)
2. Agents subscribed to that channel **receive the event** (filtered by their `listensTo` declarations)
3. Agent logic runs and **emits new events**
4. Emitted events are published to the agent's **publishTo channels**
5. Other agents on those channels pick up the events, continuing the chain
6. Events on channels with an **SSE proxy** are streamed to the client

```text
Start Event → Main Channel → Agent A → Processing Channel → Agent B → Client Channel → SSE
```

See [Channel API](../api-reference/channel-api.md) for full reference.
