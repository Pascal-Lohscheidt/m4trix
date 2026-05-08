# Channel API

Channels are named conduits for events. They route events between agents and connect to external systems via sinks.

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

### `.sink(sinkFactory)`

Attach a sink. Can be called multiple times for multiple sinks.

```ts
const client = createChannel('client').sink(sink.httpStream());
const output = createChannel('output')
  .sink(sink.httpStream())
  .sink(sink.kafka({ topic: 'output-events' }));
```

## Sink Factories

| Sink | Description |
|------|-------------|
| `sink.httpStream()` | Streams events as SSE to HTTP clients |
| `sink.kafka({ topic })` | Publishes events to a Kafka topic |

## See Also

- [Channels (Concepts)](../concepts/channels.md)
- [Streaming, Sinks & Adapters](../concepts/streaming-sinks-adapters.md)
- [AgentNetwork](agent-network.md)
