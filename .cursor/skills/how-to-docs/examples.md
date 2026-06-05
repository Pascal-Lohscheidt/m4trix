# Example: How to communicate between frontend and agent

Reference output for the skill. Section inside `docs/getting-started/how-to.md`.

---

```markdown
---
title: "How to communicate between frontend and agent"
description: "Wire an agent network to the browser over SSE with a route handler and a streaming client."
---

The browser sends a request to an exposed endpoint; agents run on the main channel and stream events back on a client channel with `proxy.sse()`. See [Streaming](../guides/streaming.md) for SSE details.

## Define events

```ts
// network/events.ts
import { AgentNetworkEvent, S } from '@m4trix/core/matrix';

export const chatRequest = AgentNetworkEvent.of(
  'chat-request',
  S.Struct({ message: S.String }),
);

export const chatResponse = AgentNetworkEvent.of(
  'chat-response',
  S.Struct({ text: S.String, done: S.Boolean }),
);
```

## Register the agent and SSE channel

```ts
// network/network.ts
const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent }) => {
    const main = mainChannel('main');
    const client = createChannel('client').proxy(proxy.sse());

    registerAgent(chatAgent).subscribe(main).publishTo(client);
  },
);
```

```ts
// network/chat-agent.ts
.logic(async ({ triggerEvent, emit }) => {
  emit({
    name: 'chat-response',
    payload: { text: `Echo: ${triggerEvent.payload.message}`, done: true },
  });
})
```

## Expose as an HTTP route

```ts
// app/api/chat/route.ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [chatRequest],
  }),
);

export const POST = NextEndpoint.from(api).handler();
```

Express is the same pattern with `ExpressEndpoint.from(api).handler()`.

## Read the SSE stream in the client

POST + `ReadableStream` (recommended):

```ts
// app/_hooks/use-agent-chat.ts
const response = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: text }),
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6));
    if (event.name === 'chat-response') {
      appendText(event.payload.text);
      if (event.payload.done) finish();
    }
  }
}
```

GET with query payload works for quick tests:

```ts
const url = '/api/chat?payload=' + encodeURIComponent(JSON.stringify({ message: 'Hi' }));
const source = new EventSource(url);
source.addEventListener('chat-response', (e) => {
  const { payload } = JSON.parse(e.data);
  appendText(payload.text);
});
```

## Auth on the exposed endpoint

```ts
// app/api/chat/route.ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [chatRequest],
    auth: async (req) => {
      const token = req.request?.headers?.get('authorization');
      if (!token) return { allowed: false, status: 401, message: 'Unauthorized' };
      return { allowed: true };
    },
  }),
);
```

Forward the same header from the client `fetch` call.

## Related

- [IO + Adapters](../api-reference/io-adapters.md)
- [Next.js](../guides/next.js.md)
- [Streaming](../guides/streaming.md)
- [Channels](../concepts/channels.md)
```

---

## Anti-patterns (don't do this)

**Full-file dump** — replaces the snippet approach:

```ts
// 120 lines of imports, agent, network, route, and UI in one block
```

**Prose-heavy** — three paragraphs before the first code block.

**Missing file context** — snippets without `// path/to/file.ts` when multiple files are involved.

**Invented APIs** — e.g. `network.streamToClient()` when the real API is `expose(registerSSEStream(...))`.
