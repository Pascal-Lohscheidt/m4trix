---
title: "Next.js"
---

Use the `NextEndpoint` adapter to expose your agent network as a Next.js App Router API route.

## Setup

1. Install m4trix:

```bash
pnpm add @m4trix/core
```

2. Create an API route (e.g. `app/api/chat/route.ts`):

```ts
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  registerSSEStream,
  NextEndpoint,
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

const handler = NextEndpoint.from(api).handler();
export const GET = handler;
export const POST = handler;
```

## How It Works

1. Receives the incoming `Request`
2. Runs auth (if configured)
3. Extracts the JSON payload from the POST body (or a GET's `?payload=`, else `{}`) and validates it against `triggerEvents`: malformed JSON or a payload the schema rejects is answered with a 400 and `{ error: 'invalid_request', issues }` before any run starts (see [Request validation](../api-reference/io-adapters.md#request-validation))
4. Creates an SSE `Response` with streaming headers
5. Publishes the start event to the main channel
6. Streams the run's events from the selected channel as SSE
7. Ends the response after `m4trix:run.completed` or `m4trix:run.failed` (see [Run Lifecycle](../api-reference/io-adapters.md#run-lifecycle)). If the client disconnects first and does not reconnect within `reconnectWindow` (default 30 seconds), the run is cancelled and agents' `signal` aborts

Along the way it writes an `id:` per durable event, a `: ping` heartbeat every 15 seconds (`NextEndpoint.from(api, { heartbeat: '30 seconds' })`, `Infinity` disables), and sends `X-Accel-Buffering: no`. A failure after the response started is logged and ends the stream with `m4trix:run.failed` (`kind: 'stream-error'`).

## Reconnects with EventSource

`EventSource` reconnects by itself and sends the last `id:` as `Last-Event-ID`; the same route then resumes the run instead of starting a new one (a 404 when there is nothing to resume, which stops the reconnects). The run stays alive across drops of up to `reconnectWindow` (30 seconds by default); close the source on the run-end event:

```ts
// route.ts
const api = network.expose(
  registerSSEStream({ channel: 'client', triggerEvents: [requestEvent] }), // reconnectWindow: '30 seconds' by default
);

// client
const source = new EventSource(`/api/chat?payload=${encodeURIComponent(JSON.stringify({ message }))}`);
source.addEventListener('chat-response', (e) => append(JSON.parse(e.data).payload.text));
for (const end of ['m4trix:run.completed', 'm4trix:run.failed', 'm4trix:run.cancelled']) {
  source.addEventListener(end, () => source.close());
}
```

See [Resuming a stream](../api-reference/io-adapters.md#resuming-a-stream-last-event-id) for what is replayed and when.

## Conversations and auth

The client picks the conversation with a header, read by `requestToContextId`. That id is client-supplied, so return the signed-in user as the **principal** from `auth`: history is looked up under `(principal, contextId)`, and a client can never reach another user's conversation by sending its id.

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [requestEvent],
    auth: async (req) => {
      const session = await getSession(req.request); // your auth library
      return session
        ? { allowed: true, principal: { id: session.user.id } }
        : { allowed: false, status: 401, message: 'Sign in first' };
    },
  }),
);

const handler = NextEndpoint.from(api, {
  requestToContextId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
  requestToRunId: () => crypto.randomUUID(),
}).handler();
```

Without `auth` (or when it allows a request without a principal), requests are anonymous and share history by `contextId` alone. See [Auth + Multi-Tenant](auth-multitenant.md).

## GET vs POST

- **GET** — The payload is URL-encoded JSON in `?payload=` (e.g. `?payload=%7B%22message%22%3A%22Hi%22%7D`), validated exactly like a POST body: malformed JSON or a schema mismatch is a 400. `EventSource` can only GET.
- **POST** — Payload in JSON body. Preferred for `fetch`-based clients.

## Full Example with OpenAI Streaming

See [IO + Adapters](../api-reference/io-adapters.md) for a complete Next.js streaming example with OpenAI.
