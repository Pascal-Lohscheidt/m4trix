# Streaming, Sinks & Adapters

## Streaming

m4trix uses **Server-Sent Events (SSE)** for streaming responses to clients. When an agent emits events to a channel with an `httpStream()` sink, those events are streamed as SSE to the browser.

### SSE Format

```text
event: agent-response
data: {"name":"agent-response","meta":{"runId":"..."},"payload":{"text":"Hello!"}}

event: agent-response
data: {"name":"agent-response","meta":{"runId":"..."},"payload":{"text":" World!"}}
```

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

## Sinks

Sinks determine how events leave a channel:

- **`sink.httpStream()`** — Streams events as SSE to HTTP clients
- **`sink.kafka({ topic })`** — Publishes events to a Kafka topic

A channel can have multiple sinks.

## Adapters

Adapters expose the network as an HTTP API:

- **NextEndpoint** — Next.js App Router (`GET`/`POST` handlers)
- **ExpressEndpoint** — Express.js route handlers

Both adapters handle request parsing, auth, and SSE response formatting. See [IO + Adapters](../api-reference/io-adapters.md) and [Streaming guide](../guides/streaming.md) for details.
