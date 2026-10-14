---
title: "Express"
---

Use the `ExpressEndpoint` adapter to expose your agent network as an Express route.

## Setup

1. Install m4trix and Express:

```bash
pnpm add @m4trix/core express
```

2. Create your Express app:

```ts
import express from 'express';
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  registerSSEStream,
  ExpressEndpoint,
  S,
} from '@m4trix/core/matrix';

const requestEvent = AgentNetworkEvent.of('chat-request', S.Struct({ message: S.String }));
const responseEvent = AgentNetworkEvent.of('chat-response', S.Struct({ text: S.String, done: S.Boolean }));

const agent = AgentFactory.run()
  .listensTo([requestEvent])
  .emits([responseEvent])
  .logic(async ({ triggerEvent, emit }) => {
    emit({
      name: 'chat-response',
      payload: { text: `Echo: ${triggerEvent.payload.message}`, done: true },
    });
  })
  .produce({});

const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(agent).subscribe(mainChannel).publishTo(client);
    // Close the response once the final chunk is out.
    endsOn(responseEvent, (event) => event.payload.done);
  },
);

const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [requestEvent],
  }),
);

const app = express();
app.use(express.json());

const handler = ExpressEndpoint.from(api).handler();
app.get('/api/stream', handler);
app.post('/api/stream', handler);

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
```

## Conversations and auth

`requestToContextId` usually reads the conversation id from a header the client sends. Return the signed-in user as the **principal** from `auth`, so history is looked up under `(principal, contextId)` and a client cannot reach another user's conversation with its id:

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [requestEvent],
    auth: async ({ req }) => {
      const user = await userFromSession(req); // your session middleware
      return user
        ? { allowed: true, principal: { id: user.id } }
        : { allowed: false, status: 401, message: 'Sign in first' };
    },
  }),
);

const handler = ExpressEndpoint.from(api, {
  requestToContextId: (req) => req.headers?.['x-correlation-id'] ?? crypto.randomUUID(),
  requestToRunId: () => crypto.randomUUID(),
}).handler();
```

Without `auth` (or when it allows a request without a principal), requests are anonymous and share history by `contextId` alone. See [Auth + Multi-Tenant](auth-multitenant.md).

## Important

- **body-parser** — Use `express.json()` (or equivalent) so POST bodies are parsed. The handler reads `req.body` for the payload; a JSON string or buffer left by a raw/text parser (with a JSON `content-type`) is parsed too.
- **Validation** — The payload is validated against `triggerEvents` after `auth`: malformed JSON or a payload the schema rejects gets a 400 with `{ error: 'invalid_request', issues }` and no run starts (see [Request validation](../api-reference/io-adapters.md#request-validation)).
- **Run end** — The response ends after `m4trix:run.completed` or `m4trix:run.failed`. Declare a terminal event with `endsOn`, or call `complete()` from an agent; otherwise the `idleTimeout` (60 seconds without agent work or events) ends the run as failed.
- **Client disconnect** — The handler listens for the `close` event: the run is cancelled, agents' `signal` aborts and `m4trix:run.cancelled` is traced.
- **GET payloads** — `EventSource` can only GET: pass the payload as `?payload=<URL-encoded JSON>` (read from `req.query`, or the URL); it is validated like a POST body.
- **Client disconnect** — The run keeps going for `reconnectWindow` (default 30 seconds, `0` cancels at once) for a reconnect; a reconnecting `EventSource` sends `Last-Event-ID` and the handler [resumes](../api-reference/io-adapters.md#resuming-a-stream-last-event-id) the run instead of starting one (404 when there is nothing to resume).
- **Compression** — If using compression middleware, the handler calls `res.flush()` when available for better streaming.
- **Heartbeats and buffering** — A `: ping` comment every 15 seconds keeps idle connections open through proxies (`ExpressEndpoint.from(api, { heartbeat: '30 seconds' })`, `Infinity` disables); `X-Accel-Buffering: no` stops nginx from buffering the stream.
- **Back-pressure** — When `res.write()` returns `false`, the next write waits for `'drain'`: a slow client holds back its own stream, not the server's memory.
- **Errors** — The handler never rejects (an async handler's rejection goes unhandled in Express 4). Errors before the stream started go to `next(error)`; mount it as `app.post('/api/stream', handler)` and Express passes `next`. Errors after the headers were sent are logged through the network's `logger` and end the stream with `m4trix:run.failed` (`kind: 'stream-error'`).
