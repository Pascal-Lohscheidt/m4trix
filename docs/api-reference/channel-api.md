---
title: "Channel API"
---

Channels are named conduits for events. They route events between agents and connect to external systems via proxies.

## Creating Channels

### Main Channel

```ts
const main = mainChannel('main');
```

Designates the channel where start events are published. Every network has exactly one main channel.

### Additional Channels

```ts
const processing = createChannel('processing');
const client = createChannel('client');
```

Channel names must be **kebab-case** (e.g. `'main'`, `'client-output'`).

## Channel Configuration

### `.events([...])`

Optionally declare which events a channel carries:

```ts
const client = createChannel('client')
  .events([responseEvent, errorEvent]);
```

### `.proxy(...proxies)`

Attach one or more proxy declarations. A channel can declare multiple proxies.

```ts
const client = createChannel('client').proxy(proxy.sse());
const output = createChannel('output')
  .proxy(proxy.sse())
  .proxy(proxy.kafka({ topic: 'output-events' }));
```

## Proxy Factories

| Proxy | Description |
|------|-------------|
| `proxy.sse()` | Streams events as SSE to HTTP clients |
| `proxy.kafka({ topic })` | Declares Kafka egress metadata |
| `proxy.socketIo({ namespace })` | Declares a future bidirectional Socket.IO proxy |
| `proxy.custom(kind, config, direction)` | Declares a user-defined proxy kind |

## See Also

- [Channels (Concepts)](../concepts/channels.md)
- [Streaming, Proxies & Adapters](../concepts/streaming-sinks-adapters.md)
- [AgentNetwork](agent-network.md)
