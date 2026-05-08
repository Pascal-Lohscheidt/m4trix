# AuthN/Z + Multi-Tenant Selection

## Authentication

Add per-request authentication via the `auth` callback in `expose()`:

```ts
const api = network.expose({
  protocol: 'sse',
  auth: async (req) => {
    const token = req.request?.headers?.get?.('authorization');
    if (!token || !isValid(token)) {
      return { allowed: false, message: 'Invalid token', status: 401 };
    }
    return { allowed: true };
  },
  select: { channels: 'client' },
  startEventName: 'user-request',
});
```

When auth fails, the adapter returns the appropriate HTTP status (e.g. 401) and message.

## Authorization (Tenant/User Context)

Pass user or tenant context into the payload using `onRequest`:

```ts
const api = network.expose({
  protocol: 'sse',
  onRequest: async ({ emitStartEvent, req, payload }) => {
    const user = await getUserFromRequest(req);
    if (!user) {
      return; // or throw / return error
    }
    const enrichedPayload = {
      ...payload,
      userId: user.id,
      tenantId: user.tenantId,
    };
    emitStartEvent(enrichedPayload);
  },
  select: { channels: 'client' },
  startEventName: 'user-request',
});
```

Your events should include `userId` and/or `tenantId` in their schema so agents can scope work correctly.

## Multi-Tenant Agent Selection

For dynamic agent creation per tenant, use the **spawner**:

```ts
spawner(AgentFactory)
  .listen(main, spawnEvent)
  .registry({ analyst: analystFactory, writer: writerFactory })
  .defaultBinding(({ kind }) => ({
    subscribe: ['main'],
    publishTo: ['client'],
  }))
  .onSpawn(({ kind, factory, payload, spawn }) => {
    const agent = factory.produce(payload.params);
    spawn(agent);
    return agent;
  });
```

The spawn event can carry `tenantId` or `userId`; `onSpawn` can select the right factory and params per tenant.

See [AgentNetwork API](../api-reference/agent-network.md) for spawner details and [IO + Adapters](../api-reference/io-adapters.md) for `onRequest`.
