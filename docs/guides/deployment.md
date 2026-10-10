---
title: "Deployment (Next.js, Express, Edge)"
---

## Next.js

Deploy a Next.js app with m4trix API routes as usual. The `NextEndpoint` handler works with:

- **Vercel** — Serverless functions; streaming is supported
- **Node.js server** — `next start` or custom server
- **Docker** — Build and run the Next.js app in a container

Ensure your runtime supports streaming responses (Vercel and Node.js do). For Edge, see below.

## Express

Use `ExpressEndpoint` for traditional Express apps:

```ts
import express from 'express';
import { ExpressEndpoint } from '@m4trix/core/matrix';

const app = express();
app.use(express.json());

const handler = ExpressEndpoint.from(api).handler();
app.get('/api/stream', handler);
app.post('/api/stream', handler);

app.listen(3000);
```

- Apply `body-parser` (or `express.json()`) for POST payloads
- The handler sets SSE headers and handles client disconnect

## Behind a proxy or load balancer

- SSE responses carry `X-Accel-Buffering: no`, so nginx streams them instead of buffering. Disable response buffering in other proxies for the stream route.
- Idle connections get a `: ping` comment every 15 seconds (`heartbeat` adapter option), below the usual 30–60 second idle timeouts of load balancers. Raise your proxy's read timeout above `maxDuration` if a single run may stream that long.
- `EventSource` clients reconnect by themselves after a drop and [resume](../api-reference/io-adapters.md#resuming-a-stream-last-event-id) the run; it keeps going for `reconnectWindow` (30 seconds by default) so it is still running when they come back.

## Scaling out

**Today a run lives on one instance.** Everything about a running run is in the memory of the process that started it: its agents' mailboxes and fibers, its limits and usage, its owner, its `emitAndAwait` waiters, and the [event plane](../api-reference/agent-network.md#event-transport) that fans its events out to SSE streams. The defaults keep history in memory too (`createInMemoryNetworkStore`). That is fine for one server, or for several servers whose requests never need another server's run.

What breaks across instances, and what each part needs:

| Need | Single instance (today) | Several instances |
|------|-------------------------|-------------------|
| History (`ctx.history`), resume replays | In-memory store | A shared [store](../api-reference/agent-network.md#writing-a-store-adapter) (Redis, Postgres, …) checked with `runStoreContract` |
| A reconnect landing on another instance | Replays the stored events, then ends with `m4trix:run.failed` `kind: 'run-unavailable'` | A distributed `transport`, so the instance serving the reconnect receives the run's live events |
| `emitAndAwait` replies and inbound events (`proxy.publish`) from another instance | Only reach the instance's own planes | A distributed `transport`; replies carry the request's `correlationId` for routing |
| A run's agents, limits, owner and run end | On the instance that started the run | Still there: route each run's inbound events (approvals, control events) to the instance that runs it |

The `transport` setup option is the seam for this: an [`EventTransport`](../api-reference/agent-network.md#event-transport) carries channel events to subscribers and replies to waiters, while every per-run concern stays in the plane. Core ships the in-memory transport only. **Redis Streams and NATS transports are planned after 1.0**, as separate packages; any implementation can be checked with `runTransportContract` from `@m4trix/core/testing`.

Until then, deploy several instances like this:

1. **Use a shared store**, so history and resume replays are the same everywhere.
2. **Route sticky**: send every request of a run (the stream, its reconnects with `Last-Event-ID`, approvals posted back for it) to the instance that started it, e.g. by hashing the conversation or run id at the load balancer, or with session affinity. Runs then never need to cross instances.
3. **Keep runs short**: a run ends with its answer; long human waits end the run (below), so an instance can be drained or replaced between runs.

With a distributed transport (post-1.0), sticky routing is no longer needed for streams and reconnects: any instance can replay from the shared store and follow the run live. Inbound events for a run's agents still go to the instance that runs it.

## Long human waits

`emitAndAwait` keeps its wait in memory, inside the waiting agent's invocation, and the run stays open while it waits: fine for an approval that takes seconds (the assistant example's command approval waits up to 10 minutes), wrong for one that takes hours, crosses a deploy or a restart, or needs a different device. For those, **end the run and continue in a new run of the same context**. `ctx.history` carries the conversation over, since history is per context (and principal), not per run.

```ts
const ApprovalRequested = AgentNetworkEvent.of('approval-requested', S.Struct({ requestId: S.String, action: S.String }));
const ApprovalGiven = AgentNetworkEvent.of('approval-given', S.Struct({ requestId: S.String, approved: S.Boolean }));

// Run 1: ask, then end the run. The request is stored in the context's history.
const planner = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([ApprovalRequested])
  .logic(async ({ emit, complete }) => {
    emit(ApprovalRequested.make({ requestId: crypto.randomUUID(), action: 'deploy to production' }));
    complete(); // the stream closes; nothing waits in memory
  })
  .produce({});

// Run 2, minutes or days later, started by the human's answer: find the request in history.
const executor = AgentFactory.run()
  .listensTo([ApprovalGiven])
  .emits([Done])
  .logic(async ({ triggerEvent, history, emit }) => {
    const { events } = await history.context({ limit: 50 });
    const request = events.filter(ApprovalRequested.is).find((e) => e.payload.requestId === triggerEvent.payload.requestId);
    if (!request || !triggerEvent.payload.approved) return emit(Done.make({ text: 'Nothing to do.' }));
    await deploy(request.payload.action);
    emit(Done.make({ text: 'Deployed.' }));
  })
  .produce({});

// Both events start runs: the answer is a request of its own, same contextId, new runId.
const api = network.expose(registerSSEStream({ channel: 'client', triggerEvents: [UserMessage, ApprovalGiven] }));
```

- The client shows `approval-requested` from the first stream, stores nothing but the context id, and later sends `{ "name": "approval-given", "payload": { … } }` as a new request with the same context id.
- Return the user as the `auth` principal: history (and so the pending request) is only visible to the principal whose run stored it.
- Check the request is still open (e.g. no later `approval-given` for its `requestId` in history) if answers may arrive twice.
- Durable, in-run waits (a run that sleeps for days and survives restarts) are not supported yet.

## Edge / Serverless

`@m4trix/core` needs Node.js 20+ or an Edge runtime (Vercel Edge, Cloudflare Workers, Deno, Bun): its runtime code uses web APIs only (`crypto.randomUUID`, `ReadableStream`, `AbortSignal`, `Request`/`Response`) and imports nothing but Effect; CI checks that the published bundle imports no Node built-in. `NextEndpoint` works in the Edge runtime as in the Node.js one.

What differs on Edge and serverless is the process model, not the API:

- The in-memory store and transport live in one isolate: use a shared `store` (and `transport`) when requests of one conversation may land on different instances
- A run lives as long as its request: keep `maxDuration` within your platform's request limit, and expect a [resume](../api-reference/io-adapters.md#resuming-a-stream-last-event-id) to continue live only on the instance that runs it (`reconnectWindow`, 30 seconds by default)

For production, **Node.js serverless** (e.g. Vercel Node.js runtime) or **Express on a long-lived server** are the most tested paths.

## Environment Variables

Store API keys and secrets in environment variables. Access them in agent logic:

```ts
.logic(async ({ triggerEvent, emit }) => {
  const apiKey = process.env.OPENAI_API_KEY;
  // ...
})
```

Never commit secrets. Use your platform's secret management (Vercel, AWS Secrets Manager, etc.).
