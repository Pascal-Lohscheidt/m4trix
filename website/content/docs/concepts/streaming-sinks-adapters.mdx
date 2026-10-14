---
title: "Streaming, Proxies & Adapters"
---

## Streaming

m4trix uses **Server-Sent Events (SSE)** for streaming responses to clients. When an agent emits events to a channel with an `sse()` proxy, those events are streamed as SSE to the browser.

### SSE Format

```text
id: ctx-1/run-1/4f0c…

id: ctx-1/run-1/9a2e…
event: agent-response
data: {"name":"agent-response","meta":{"runId":"run-1",…},"payload":{"text":"Hello!"}}

event: token
data: {"name":"token","meta":{…},"payload":{"delta":" World"}}

: ping
```

Every durable event carries an `id:`: its position in the run. The first `id:` (without data) is the position of the run's start event. Transient events (token deltas) have none. `: ping` is a heartbeat comment, every 15 seconds by default, that keeps idle connections open through proxies; adapters also send `X-Accel-Buffering: no` so nginx does not buffer the stream.

### Reconnecting

When the connection drops, `EventSource` reconnects by itself and sends the last id as `Last-Event-ID` (polyfills can use `?lastEventId=`). The server then **resumes** the run instead of starting a new one: it replays the run's durable events after that id from the store (only the requesting principal's), and continues live while the run is still going, or ends with the run's end event. Transient events are not replayed. A run whose stream drops keeps going for `reconnectWindow` (30 seconds by default) for a reconnect, then is cancelled; `reconnectWindow: 0` cancels it at once. See [Resuming a stream](../api-reference/io-adapters.md#resuming-a-stream-last-event-id).

### Streaming from Agents

Emit multiple events during an LLM stream:

```ts
for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    emit({
      name: 'response',
      payload: { text: content, isFinal: false },
    });
  }
}
emit({ name: 'response', payload: { text: '', isFinal: true } });
```

### Ending a Stream

A stream lasts as long as its **run**. The run ends on a terminal event declared with `endsOn`, when an agent calls `complete()` or fails, on the `idleTimeout` / `maxDuration` safety net (60 seconds idle, i.e. no agent running and no events / 10 minutes by default), when it exceeds a run limit (`maxDepth` 25 hops and `maxEvents` 1000 events by default; optional `maxTokens` / `maxCostUsd` budgets), or when the client disconnects. The last event a client receives is `m4trix:run.completed` or `m4trix:run.failed`; then the response closes.

```ts
AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
  // ...
  endsOn(responseEvent, (event) => event.payload.isFinal);
});
```

See [Run Lifecycle](../api-reference/io-adapters.md#run-lifecycle).

## Proxies

Proxies declare how events leave a channel:

- **`proxy.sse()`** — Streams events as SSE to HTTP clients
- **`proxy.custom(kind)`** — Your own proxy kind, exposed with `registerCustomProxy` (see [Custom Proxies](../api-reference/io-adapters.md#custom-proxies)). Kafka and Socket.IO bridges are planned on top of `EventTransport`

A channel can have multiple proxies.

## Adapters

Adapters expose the network as an HTTP API:

- **NextEndpoint** — Next.js App Router (`GET`/`POST` handlers)
- **ExpressEndpoint** — Express.js route handlers

Both adapters handle request parsing (POST body or GET `?payload=` for `EventSource`), auth, SSE response formatting, heartbeats, resumes and errors after the response started. See [IO + Adapters](../api-reference/io-adapters.md) and [Streaming guide](../guides/streaming.md) for details.
