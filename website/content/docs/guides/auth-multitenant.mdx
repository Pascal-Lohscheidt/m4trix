---
title: "AuthN/Z + Multi-Tenant Isolation"
---

Agents read conversation history with `ctx.history` (see [Event history](../api-reference/agent-network.md#event-history-and-stores)). History is keyed by a `contextId` that the **client** sends (usually a header read by `requestToContextId`), so the `contextId` alone must never decide whose history a run sees. m4trix scopes history by a **principal**: the identity your `auth` callback returns.

## Authenticate and return a principal

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [userRequestEvent],
    auth: async (req) => {
      const session = await getSession(req.request?.headers.get('authorization'));
      if (!session) {
        return { allowed: false, status: 401, message: 'Invalid token' };
      }
      return {
        allowed: true,
        // `id` namespaces history; other fields reach agents and tools as they are.
        principal: { id: session.userId, tenantId: session.tenantId, role: session.role },
      };
    },
  }),
);

export const POST = NextEndpoint.from(api, {
  // Client-supplied, and safe: it is only looked up within the principal's namespace.
  requestToContextId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
  requestToRunId: () => crypto.randomUUID(),
}).handler();
```

`AuthResult` is `{ allowed: true; principal?: Principal } | { allowed: false; status?; message? }`, where `Principal` is `{ id: string; [claim: string]: unknown }`. When auth fails, the adapter answers with `status` (default 401) and `message`. A principal without a non-empty string `id` fails the request.

Derive the principal from something the client cannot forge (a verified session or token), never from a plain header such as `x-user-id`.

## What the principal does

- **History namespace.** Every event the run publishes is stored under `(principal:<id>, contextId)`. `ctx.history.run()` and `ctx.history.context()` only read that namespace, so two users who send the same `contextId` get two separate conversations.
- **Event meta.** The start event and everything the run's agents emit carry `meta.principalId`; so do the run's `m4trix:*` lifecycle events.
- **Agents and tools.** Agent logic gets the full principal as `ctx.principal` (`undefined` for anonymous runs); tool `define` callbacks get it as `principal`.
- **`onRequest`.** The callback receives `principal`, and `emitStartEvent` stamps it on the start event: you cannot start a run for another principal from there.
- **Run ownership.** A run belongs to the principal of its first event. Events for that run with another `principalId` (or none) are refused: not stored, not delivered. A request whose `runId` belongs to another principal fails with `ExposeAuthError` (403).
- **Streams.** A stream only yields events of its own principal, also on a shared `plane`.

```ts
.logic(async ({ principal, history, emit }) => {
  if (principal?.role !== 'admin') { /* ... */ }
  const { events } = await history.context({ limit: 50 }); // this principal's conversation only
})
```

## Anonymous requests

Requests allowed **without** a principal, and every request when no `auth` is configured, run in one shared **anonymous** namespace. Within it, history is shared by `contextId` alone: any client that knows (or guesses) a `contextId` reads that conversation and can add to it. That is fine for a single-user or local app; for anything multi-user, return a principal for every request that carries an identity, and treat `contextId`s as secrets otherwise.

Anonymous and authenticated histories never mix: an anonymous request with a `contextId` used by a principal sees none of that principal's events, and the other way round.

## Proxy publishes (`publish`, `withMeta`, `publishInbound`)

Proxies (`api.publish`, `api.withMeta(...).publish`, a custom proxy's `publishInbound`) are called by your server code, often with data relayed from a client. They never take the principal from the event: a `meta.principalId` on the envelope or in `meta` is dropped, and `meta` does not accept one in its type. Pass the principal explicitly, from your own auth:

```ts
// e.g. an approval posted back by the client, for a run of the signed-in user
await api.publish(ApprovalResolved.make({ approved: true }), {
  meta: { runId, contextId, correlationId },
  principal: { id: session.userId },
});

await api.withMeta({ runId, contextId }, { principal: { id: session.userId } }).publish(event);
```

Without `principal` the event is anonymous, so it is refused (`publish` resolves `false`) when the run belongs to a principal. Code that publishes on the plane directly (`plane.publish`) is trusted: it may set `meta.principalId` itself.

## Tenant data in agents

Use the principal's claims rather than copying identity into event payloads:

```ts
.logic(async ({ principal, layers }) => {
  const docs = await layers.Search.query({ tenantId: principal?.tenantId, q: '...' });
})
```

## Multi-tenant agent selection

Agents are registered once, at setup; per-tenant behavior comes from the run's `principal`. Branch on it in `logic`, or let a dependency layer pick the tenant's resources (model, index, credentials):

```ts
.logic(async ({ principal, layers, emit }) => {
  const model = layers.Models.forTenant(principal?.tenantId);
  emit(Answer.make({ text: await model.answer(/* ... */) }));
})
```

See [AgentNetwork API](../api-reference/agent-network.md) for stores and [IO + Adapters](../api-reference/io-adapters.md) for `auth` and `onRequest`.
