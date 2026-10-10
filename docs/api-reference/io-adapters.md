---
title: "IO + Adapters (NextEndpoint, Express, etc.)"
---

The IO layer turns an `AgentNetwork` into an HTTP API. Built-in adapters: **NextEndpoint** (Next.js) and **ExpressEndpoint** (Express).

## Exposing a Network

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [UserRequestEvent],
  }),
);
```

## registerSSEStream() Options

| Option | Description |
|--------|-------------|
| `auth` | Per-request auth callback: `async (req) => ({ allowed: true, principal? })` or `({ allowed: false, status?, message? })`. The `principal` (`{ id, ...claims }`) namespaces the run's history and reaches agents and tools as `ctx.principal`; without one the request is anonymous. See [Auth + Multi-Tenant](../guides/auth-multitenant.md) |
| `channel` | Channel to stream from |
| `events` | Filter to specific event names (string[]) |
| `triggerEvents` | Event definitions that can trigger a run. Request payloads are validated against them before anything runs (see [Request validation](#request-validation)) |
| `onRequest` | Callback before streaming; must call `emitStartEvent()` if provided. Receives `{ req, payload, principal, emitStartEvent, setRunId, setContextId }`; `emitStartEvent` stamps the request's principal on the start event, and validates the event when the network knows it (see [Request validation](#request-validation)) |
| `plane` | Optional: reuse existing EventPlane |
| `idleTimeout` | Fail the run when it sits idle this long: no agent invocation of the run in flight or queued and no event published for it. Time spent inside an invocation (an LLM call, a tool waiting for approval) never counts. Default `'60 seconds'`; `Infinity` disables |
| `maxDuration` | Fail the run when it is still going after this long, stuck agents included. Default `'10 minutes'`; `Infinity` disables |
| `reconnectWindow` | How long a run keeps going after its stream dropped, for a reconnect to [resume](#resuming-a-stream-last-event-id) it. Default `'30 seconds'` (`DEFAULT_RECONNECT_WINDOW`); afterwards the run is cancelled. `0` cancels it as soon as its stream closes |
| `maxDepth`, `maxEvents`, `maxTokens`, `maxCostUsd` | Run limits for each exposed run; they override the network's [setup options](agent-network.md#setup-options), also on a shared `plane` (for this stream's runs only) |

## NextEndpoint

```ts
import { NextEndpoint } from '@m4trix/core/matrix';

const handler = NextEndpoint.from(api).handler();
export const GET = handler;
export const POST = handler;
```

Maps `ExposedAPI` to Next.js App Router handlers. Handles `Request`, auth, payload extraction (POST body or GET `?payload=`), [resumes](#resuming-a-stream-last-event-id), SSE response.

| Option | Description |
|--------|-------------|
| `requestToContextId`, `requestToRunId` | Map the request to the run's ids. Default: a fresh id per request |
| `heartbeat` | Interval of the `: ping` comment that keeps idle streams open through proxies and load balancers. Default `'15 seconds'`; `Infinity` disables |
| `logger` | Where stream failures are logged. Defaults to the network's [`logger`](../guides/error-handling-observability.md#logger) |

Responses carry `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` and `X-Accel-Buffering: no` (stops nginx from buffering the stream). A failure after the response started (the stream could not be read any more) is logged and ends the stream cleanly with a client-safe `m4trix:run.failed` (`kind: 'stream-error'`), unless the client is already gone.

## ExpressEndpoint

```ts
import { ExpressEndpoint } from '@m4trix/core/matrix';

const handler = ExpressEndpoint.from(api).handler();
app.get('/api/stream', handler);
app.post('/api/stream', handler);
```

Requires `express.json()` (or body-parser) for POST; GET takes the payload as `?payload=`. Handles client disconnect and `res.flush()` when available, and takes the same `heartbeat` and `logger` options and sends the same headers as `NextEndpoint`.

- **Back-pressure**: when `res.write()` returns `false` (the socket's buffer is full), the next write waits for `'drain'`, so a slow client holds back its own stream instead of filling the server's memory.
- **Errors never reject the handler** (an async handler's rejection goes unhandled in Express 4): before the stream started they go to `next(error)` (a 500 without `next`); after it started they are logged and the stream ends with `m4trix:run.failed` (`kind: 'stream-error'`).

## Request validation

Payloads usually come from a browser or another service, so `expose()` checks them before it creates a run, invokes an agent or starts a trace. `auth` runs first, so unauthenticated callers never learn about your schemas.

- **GET requests** carry the payload as `?payload=<URL-encoded JSON>`, since `EventSource` can only GET: `new EventSource('/api/chat?payload=' + encodeURIComponent(JSON.stringify({ message: 'Hi' })))`. It is checked exactly like a POST body (including the `{ name, payload }` shape below); a GET without it has the payload `{}`.
- **Malformed JSON** (a POST with a JSON content type, a `?payload=`, or an Express `req.body` left as a JSON string or buffer by a raw/text body parser) is refused instead of becoming `{}`. An empty body still counts as `{}`.
- **Without `onRequest`**, the payload is decoded with the trigger event's schema and the start event carries the decoded value (schema transformations applied, unknown properties dropped).
  - One trigger event: the request body is its payload.
  - Several trigger events: the body names the event, `{ "name": "<trigger event name>", "payload": { ... } }`. Trying each schema in turn was rejected on purpose: object schemas ignore unknown properties, so a permissive schema early in the list would silently claim payloads meant for another event. A missing or unknown `name` is refused with an issue at `name`; payload issues are located under `payload`.
  - No trigger events: the payload is published unchecked as a `request` event, as before.
- **With `onRequest`**, the body is only parsed; the event passed to `emitStartEvent` is checked against its definition when the network knows the name (a trigger event, or an event an agent listens to or emits, or a channel declares). An invalid one makes `emitStartEvent` throw; let it propagate out of `onRequest`.
- `expose()` throws at setup when the main channel declares `.events()` that exclude a trigger event.

A refused request rejects `createStream` with `ExposeValidationError` (`status: 400`, `issues: { path, message }[]`). `NextEndpoint` and `ExpressEndpoint` answer it with a 400 and a JSON body:

```json
{ "error": "invalid_request", "issues": [{ "path": "message", "message": "Expected string, actual 42" }] }
```

Malformed JSON gives `issues: [{ "path": "", "message": "Request body is not valid JSON" }]` (`"The payload query parameter is not valid JSON"` for `?payload=`). The body never contains a raw `ParseError`. Custom proxies catch the same error and use `error.toJSON()` as the body:

```ts
try {
  await api.createStream(req, consume);
} catch (error) {
  if (error instanceof ExposeValidationError) return reply(error.status, error.toJSON());
  throw error;
}
```

Proxy `publish` / `publishInbound` do not validate payloads; they only enforce the target channel's `.events()`.

## Response Format

Events are streamed as SSE. Every durable event has an `id:` (its resume position); a stream that started a run first sends the position of its start event, without data:

```text
id: ctx-1/run-1/4f0c…

id: ctx-1/run-1/9a2e…
event: agent-response
data: {"name":"agent-response","meta":{"runId":"run-1","contextId":"ctx-1","eventId":"9a2e…"},"payload":{"text":"Hello!"}}

event: token
data: {"name":"token","meta":{…},"payload":{"delta":"Hel"}}

: ping
```

- Transient events (`{ transient: true }`) have no `id:`: they are never stored, so a resume cannot replay them.
- `: ping` is the [heartbeat](#nextendpoint) comment; clients ignore it.
- Event names are kept on one line (line breaks become spaces), so a name cannot inject SSE fields. A payload `JSON.stringify` cannot serialize does not end the stream: BigInts are sent as strings and repeated (e.g. cyclic) objects as `"[Circular]"`, or, when even that fails, the payload is replaced by `{ "error": "unserializable-payload" }`; each case is logged as a warning.

## Resuming a stream (Last-Event-ID)

When an `EventSource` loses its connection it reconnects to the same URL and sends the last `id:` it received as the `Last-Event-ID` header. Polyfills that cannot set headers can pass it as `?lastEventId=` instead. Such a request **resumes** its run instead of starting one: no payload is read, `onRequest` is not called, nothing is published and no trace starts.

1. The id names the run and the position: `<contextId>/<runId>/<eventId>` (each part URI-encoded). It identifies the run by itself, so resuming works whatever `requestToRunId` returns, also for random ids.
2. The run's durable events after that position are read from the network's [store](agent-network.md#event-history-and-stores), in the namespace of the request's own principal (`auth` runs first, as always). Only the events this stream would have carried are replayed: the stream's channel (stores keep the channels an event was published to), the `events` filter, and the run's lifecycle events (`m4trix:*`, stored like any event). Transient events are not replayed.
3. If the run is still going on this server, the stream continues live after the replay (events published meanwhile are not repeated). If it ended, the stream ends with its run-end event, also when the resume position is that very event.

| Situation | Response |
|-----------|----------|
| Run ended (in the store) | Replay, ending with `m4trix:run.completed` / `failed` / `cancelled` |
| Run still going on this server | Replay, then live until its run-end event |
| Run unknown or expired, position not one of its events, malformed id, or the run of **another principal** (never told apart, so ids leak nothing) | `ExposeRunNotFoundError` → **404** `{ "error": "run_not_found" }`, which makes `EventSource` stop reconnecting |
| Run has stored events but neither runs here nor has a run-end event (another instance runs it, or its server stopped) | Replay, then `m4trix:run.failed` with `kind: 'run-unavailable'`, sent to this stream only (never stored, no `id:`) |

A run whose stream drops keeps going for `reconnectWindow` (default 30 seconds) so its client can reconnect and continue live. Tune it, or set `0` to cancel the run as soon as its stream closes (a resume then replays the run up to its `m4trix:run.cancelled`):

```ts
registerSSEStream({ triggerEvents: [chatRequest], reconnectWindow: '2 minutes' });
registerSSEStream({ triggerEvents: [chatRequest], reconnectWindow: 0 }); // cancel at once
```

Within the window a resumed stream continues the run live (and the window restarts whenever the last stream of the run drops). Once nobody reads the run for the whole window, it is cancelled with the original reason (`client-abort` or `stream-closed`): its agents' `signal` aborts, and the tracer and `onMetric` report the run as cancelled. The request handler returns once the run ended or was cancelled, so a client that left for good holds the run (and its agents) for at most the window. Resuming needs the run's state on the server that answers the reconnect: see [Deployment](../guides/deployment.md#scaling-out) for several instances.

On the client, `EventSource` does all of this by itself; close it on the run-end event, or it reconnects once more and gets the run-end event again:

```ts
const source = new EventSource(`/api/chat?payload=${encodeURIComponent(JSON.stringify({ message }))}`);
source.addEventListener('agent-response', (e) => render(JSON.parse(e.data)));
for (const end of ['m4trix:run.completed', 'm4trix:run.failed', 'm4trix:run.cancelled']) {
  source.addEventListener(end, () => source.close());
}
```

Fetch-based clients do the same by remembering the last `id:` and sending it as `Last-Event-ID` when they reconnect. Custom proxies get the ids from the stream: `stream.idOf(envelope)` (undefined for transient events) and `stream.startId`; `formatSSE(envelope, { id })` writes them.

## Run Lifecycle

Each request that publishes a start event owns a **run**. The run ends exactly once, and the stream closes right after it delivers the run-end event. A run ends when:

- a terminal event declared with [`endsOn`](agent-network.md#endsonevent-when) is published,
- an agent calls `complete()` or `fail(error)` in its logic (a tool can call `complete()`),
- an agent throws, or emits an event it may not, and the network uses `onAgentError: 'fail'` (the default),
- the run hits `idleTimeout` or `maxDuration`, or exceeds a run limit (`maxDepth`, `maxEvents`, `maxTokens`, `maxCostUsd`),
- the client disconnects or the consumer stops reading.

The runtime publishes the outcome as an ordinary envelope on every channel. Custom proxies, stores and tracers see it like any other event:

| Event | Payload | When |
|-------|---------|------|
| `m4trix:run.completed` | `{ reason: 'terminal-event', event }` or `{ reason: 'agent', agentId }` | Terminal event or `complete()` |
| `m4trix:run.failed` | `{ error: { name, message, kind }, agentId? }` | `kind`: `'agent-error'`, `'idle-timeout'`, `'max-duration'`, `'store-error'` (an event could not be written to the [store](agent-network.md#write-failures-and-ordering)), `'invalid-emit'` (an agent or tool emitted an undeclared event, an invalid payload, or to channels that refuse it; `error` also has the `event` name) or `'limit-exceeded'` (then `error` also has `limit: 'depth' \| 'events' \| 'tokens' \| 'cost'` and `max`). Two kinds only ever reach one stream and are never stored: `'run-unavailable'` ([resume](#resuming-a-stream-last-event-id) of a run this server neither runs nor has a run-end event of) and `'stream-error'` (the server failed to keep writing the stream) |
| `m4trix:run.cancelled` | `{ reason: 'client-abort' \| 'stream-closed' }` | Client gone; recorded for tracers and the store only |
| `m4trix:agent.error` | `{ agentId, trigger, error: { name, message } }` | Agent threw under `onAgentError: 'continue'`; the run goes on |

The three run-end payloads also carry `usage` (totals and `byModel`) once an agent or tool called `reportUsage()` in the run. Timeouts and exceeded limits are failures with their own `kind`, not a separate event. Errors are sanitized: clients get `name` and `message`, never stack traces. The tracer's `onRunEnd(meta, error, { status })` gets the original error and `status: 'error'`; a cancelled run reports `status: 'cancelled'` (with a `RunCancelledError` as `error`, for tracers that ignore the status).

When a run ends, its in-flight agents are aborted through their `signal` and later emits for the run are dropped. Use the exported names and guards instead of string literals:

```ts
import { isRunEndEnvelope, RunLifecycleEvent } from '@m4trix/core/matrix';

for await (const envelope of stream) {
  if (isRunEndEnvelope(envelope) && envelope.name === RunLifecycleEvent.failed) {
    throw new Error(envelope.payload.error.message);
  }
  // ...
}
```

A stream that owns a run only yields (and only buffers) that run's events, so concurrent requests on a shared `plane` never see each other's output, and a client that reads slowly only holds back its own run. A stream that publishes no start event (a shared `plane` without `onRequest`) only observes its channel: it yields the events of its own principal (`meta.principalId`; anonymous streams see anonymous events) until the client disconnects. Every stream is limited to its principal's events, and a request whose `runId` belongs to another principal's run fails with `ExposeAuthError` (403). `m4trix:*` names are reserved; `AgentNetworkEvent.of()` rejects them.

## Full Example: Next.js Streaming API

```ts
// app/api/chat/route.ts
import OpenAI from 'openai';
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  NextEndpoint,
  registerSSEStream,
  S,
} from '@m4trix/core/matrix';

const chatRequest = AgentNetworkEvent.of('chat-request', S.Struct({ message: S.String }));
const chatResponse = AgentNetworkEvent.of('chat-response', S.Struct({ text: S.String, done: S.Boolean }));

const chatAgent = AgentFactory.run()
  .listensTo([chatRequest])
  .emits([chatResponse])
  .logic(async ({ triggerEvent, emit, signal }) => {
    const openai = new OpenAI();
    // `signal` aborts the LLM call when the run ends or the client disconnects.
    const stream = await openai.chat.completions.create(
      {
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: triggerEvent.payload.message }],
      },
      { signal },
    );
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) emit({ name: 'chat-response', payload: { text, done: false } });
    }
    emit({ name: 'chat-response', payload: { text: '', done: true } });
  })
  .produce({});

const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(chatAgent).subscribe(mainChannel).publishTo(client);
    // The run, and the SSE response, ends with the final chunk.
    endsOn(chatResponse, (event) => event.payload.done);
  },
);

const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [chatRequest],
  }),
);

const handler = NextEndpoint.from(api).handler();
export const GET = handler;
export const POST = handler;
```

## Migration

```ts
// Before
createChannel('client').sink(sink.httpStream());
network.expose({ protocol: 'sse', select: { channels: 'client' }, onRequest });

// After — built-in SSE
createChannel('client').proxy(proxy.sse());
network.expose(registerSSEStream({ channel: 'client', onRequest }));
```

## Custom Proxies

Use `defineProxyKind()` when an app needs to build its own transport around the shared event stream machinery.

```ts
const TrpcStreamProxy = defineProxyKind('trpc-stream');

createChannel('client').proxy(TrpcStreamProxy.onChannel());

const api = network.expose(
  TrpcStreamProxy.register({ channel: 'client', onRequest }, ({ createInteractiveStream }) =>
    createInteractiveStream({ onRequest }),
  ),
);
```

Streams created through `createInteractiveStream` get the same [run lifecycle](#run-lifecycle) as `registerSSEStream`.

For inbound human-in-the-loop or control events on a long-lived runtime, expose with a shared `plane` and publish directly:

```ts
await api.publish(HumanApproved.make({ approved: true }), {
  target: 'main',
  meta: { runId, contextId },
  // The run's principal, from your own auth. Never taken from the event or `meta`.
  principal: { id: session.userId },
});
```

Proxy publishes drop any `meta.principalId` the event carries; the `principal` option (also `withMeta(meta, { principal })` and a custom proxy's `publishInbound(envelope, target, { principal })`) is the only way to set it. Without it the event is anonymous, and `publish` resolves `false` when the event's run belongs to a principal. See [Auth + Multi-Tenant](../guides/auth-multitenant.md#proxy-publishes-publish-withmeta-publishinbound).

## See Also

- [Next.js Guide](../guides/next.js.md)
- [Express Guide](../guides/express.md)
- [Auth + Multi-Tenant](../guides/auth-multitenant.md)
