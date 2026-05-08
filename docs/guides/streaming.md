# Streaming: SSE/WebSocket, Backpressure, Chunking

## SSE (Server-Sent Events)

m4trix uses **SSE** for streaming agent responses to HTTP clients. When agents emit events to a channel with `sink.httpStream()`, those events are streamed as SSE.

### How It Works

1. Client sends a POST with a JSON payload.
2. `expose()` publishes a start event to the main channel.
3. Agents run and emit events to the client channel.
4. Events are streamed as SSE to the response.

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
```

Or use `fetch` with `ReadableStream` for POST:

```ts
const res = await fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ query: 'Hi' }),
});
const reader = res.body!.getReader();
// ... read chunks
```

## WebSocket

m4trix focuses on **SSE** (request → stream response). For bidirectional WebSocket, you would need to adapt the event plane or use a separate WebSocket layer. The `useSocketConversation` hook in `@m4trix/react` can work with WebSocket backends when your server exposes a compatible protocol.

## Backpressure

The HTTP stream sink respects backpressure: if the client is slow to consume, the underlying stream will backpressure. For LLM streams, emitting chunk-by-chunk naturally paces the flow.

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

For lower-level stream processing (rechunking, batching), use the `Pump` from `@m4trix/stream` — see [Streaming, Sinks & Adapters](../concepts/streaming-sinks-adapters.md).
