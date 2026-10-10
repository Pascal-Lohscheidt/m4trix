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

Optionally declare which events a channel carries. The declaration is enforced:

```ts
const client = createChannel('client')
  .events([responseEvent, errorEvent]);
```

- An agent publishes each emitted event only to those of its `publishTo` channels that accept it. When none does, `emit` throws `EmitValidationError` (`reason: 'channel'`) and the agent's [`onAgentError`](agent-network.md#setup-options) policy applies (run failure `kind: 'invalid-emit'`).
- An external publish (`plane.publish`, proxy `publish` / `publishInbound`) of an event the channel does not accept resolves `false`; the event is not delivered and a warning goes to the network's `logger`. The run is not failed, the same as an event refused because its run belongs to another principal.
- Runtime `m4trix:*` events (run end, agent errors) always pass.
- A channel without `.events()` carries every event.

Contradictions are caught when the network is set up: an agent that emits an event none of its publish channels accepts, or listens to one none of its subscribed channels accepts, makes `AgentNetwork.setup()` throw. See [Wiring check](agent-network.md#wiring-check).

### `.proxy(...proxies)`

Attach one or more proxy declarations. A channel can declare multiple proxies.

```ts
const client = createChannel('client').proxy(proxy.sse());
const output = createChannel('output')
  .proxy(proxy.sse())
  .proxy(proxy.custom('queue', { topic: 'output-events' }));
```

## Proxy Factories

| Proxy | Description |
|------|-------------|
| `proxy.sse()` | Streams events as SSE to HTTP clients |
| `proxy.custom(kind, config, direction)` | Declares a user-defined proxy kind (see [Custom Proxies](io-adapters.md#custom-proxies)) |

Kafka and Socket.IO proxies are not built in; bridges for them are planned on top of [`EventTransport`](agent-network.md#event-transport).

## See Also

- [Channels (Concepts)](../concepts/channels.md)
- [Streaming, Proxies & Adapters](../concepts/streaming-sinks-adapters.md)
- [AgentNetwork](agent-network.md)
