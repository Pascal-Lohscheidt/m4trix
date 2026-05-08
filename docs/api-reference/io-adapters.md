# IO + Adapters (NextEndpoint, Express, etc.)

The IO layer turns an `AgentNetwork` into an HTTP API. Built-in adapters: **NextEndpoint** (Next.js) and **ExpressEndpoint** (Express).

## Exposing a Network

```ts
const api = network.expose({
  protocol: 'sse',
  select: { channels: 'client' },
  startEventName: 'user-request',
});
```

## expose() Options

| Option | Description |
|--------|-------------|
| `protocol` | `'sse'` (currently the only option) |
| `auth` | Per-request auth callback: `async (req) => { allowed, message?, status? }` |
| `select.channels` | Channel(s) to stream from (string or string[]) |
| `select.events` | Filter to specific event names (string[]) |
| `startEventName` | Event name published when request arrives (default: `'request'`) |
| `onRequest` | Callback before streaming; must call `emitStartEvent()` if provided |
| `plane` | Optional: reuse existing EventPlane |

## NextEndpoint

```ts
import { NextEndpoint } from '@m4trix/core/matrix';

const handler = NextEndpoint.from(api).handler();
export const GET = handler;
export const POST = handler;
```

Maps `ExposedAPI` to Next.js App Router handlers. Handles `Request`, auth, payload extraction, SSE response.

## ExpressEndpoint

```ts
import { ExpressEndpoint } from '@m4trix/core/matrix';

const handler = ExpressEndpoint.from(api).handler();
app.get('/api/stream', handler);
app.post('/api/stream', handler);
```

Requires `express.json()` (or body-parser) for POST. Handles client disconnect and `res.flush()` when available.

## Response Format

Events are streamed as SSE:

```text
event: agent-response
data: {"name":"agent-response","meta":{"runId":"..."},"payload":{"text":"Hello!"}}
```

## Full Example: Next.js Streaming API

```ts
// app/api/chat/route.ts
import OpenAI from 'openai';
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  NextEndpoint,
  S,
} from '@m4trix/core/matrix';

const chatRequest = AgentNetworkEvent.of('chat-request', S.Struct({ message: S.String }));
const chatResponse = AgentNetworkEvent.of('chat-response', S.Struct({ text: S.String, done: S.Boolean }));

const chatAgent = AgentFactory.run()
  .listensTo([chatRequest])
  .emits([chatResponse])
  .logic(async ({ triggerEvent, emit }) => {
    const openai = new OpenAI();
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: triggerEvent.payload.message }],
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) emit({ name: 'chat-response', payload: { text, done: false } });
    }
    emit({ name: 'chat-response', payload: { text: '', done: true } });
  })
  .produce({});

const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, sink, registerAgent }) => {
    const main = mainChannel('main');
    const client = createChannel('client').sink(sink.httpStream());
    registerAgent(chatAgent).subscribe(main).publishTo(client);
  },
);

const api = network.expose({
  protocol: 'sse',
  select: { channels: 'client' },
  startEventName: 'chat-request',
});

const handler = NextEndpoint.from(api).handler();
export const GET = handler;
export const POST = handler;
```

## See Also

- [Next.js Guide](../guides/next.js.md)
- [Express Guide](../guides/express.md)
- [Auth + Multi-Tenant](../guides/auth-multitenant.md)
