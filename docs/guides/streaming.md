---
title: "Streaming: SSE/WebSocket, Backpressure, Chunking"
---

## SSE (Server-Sent Events)

m4trix uses **SSE** for streaming agent responses to HTTP clients. When agents emit events to a channel with `proxy.sse()`, those events are streamed as SSE.

### How It Works

1. Client sends a POST with a JSON payload.
2. `expose()` publishes a start event to the main channel.
3. Agents run and emit events to the client channel.
4. Events are streamed as SSE to the response.
5. When the run ends (terminal event from `endsOn`, `complete()`, an agent failure, a timeout), the last event is `m4trix:run.completed` or `m4trix:run.failed`, and the response closes. See [Run Lifecycle](../api-reference/io-adapters.md#run-lifecycle).

### Response Format

```text
event: agent-response
data: {"name":"agent-response","meta":{"runId":"..."},"payload":{"text":"Hello"}}

event: agent-response
data: {"name":"agent-response","meta":{"runId":"..."},"payload":{"text":" World"}}
```

### Consuming in the Browser

```ts
const eventSource = new EventSource('/api/chat?payload=' + encodeURIComponent(JSON.stringify({ query: 'Hi' })));
eventSource.addEventListener('agent-response', (e) => {
  const data = JSON.parse(e.data);
  console.log(data.payload.text);
});
// EventSource reconnects when a response ends: close it once the run is over.
eventSource.addEventListener('m4trix:run.completed', () => eventSource.close());
eventSource.addEventListener('m4trix:run.failed', () => eventSource.close());
```

Or use `fetch` with `ReadableStream` for POST:

```ts
const res = await fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ query: 'Hi' }),
});
const reader = res.body!.getReader();
// ... read chunks until `done`: the server closes the response when the run ends
```

## WebSocket

m4trix focuses on **SSE** (request → stream response). For bidirectional WebSocket, you would need to adapt the event plane or use a separate WebSocket layer. The `useSocketConversation` hook in `@m4trix/react` can work with WebSocket backends when your server exposes a compatible protocol.

## Disconnects

When the client goes away, the run is cancelled: agents' `signal` aborts, later emits are dropped, and `m4trix:run.cancelled` is recorded for tracers and the store.

## Backpressure

The SSE proxy respects backpressure: if the client is slow to consume, the underlying stream will backpressure. For LLM streams, emitting chunk-by-chunk naturally paces the flow.

## Chunking

When streaming LLM output, emit each token or logical chunk as a separate event:

```ts
for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    emit({ name: 'response', payload: { text: content, isFinal: false } });
  }
}
emit({ name: 'response', payload: { text: '', isFinal: true } });
```

For lower-level stream processing (rechunking, batching), use the `Pump` from `@m4trix/stream` — see [Streaming, Proxies & Adapters](../concepts/streaming-sinks-adapters.md).
