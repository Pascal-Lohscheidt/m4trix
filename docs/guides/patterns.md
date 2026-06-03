---
title: "Patterns: Request/Response, Fan-Out, Join, Retries"
---

## Request/Response (Single Agent)

The simplest pattern: one agent listens for a request, does work, and emits a response.

```ts
registerAgent(myAgent).subscribe(main).publishTo(client);
```

See [Hello World](../getting-started/hello-world.md) for a full example.

## Fan-Out

One event triggers multiple agents in parallel. All agents receive the same event and emit to the same (or different) channels.

```ts
registerAgent(agentA).subscribe(main).publishTo(client);
registerAgent(agentB).subscribe(main).publishTo(client);
registerAgent(agentC).subscribe(main).publishTo(client);
```

Use when you need parallel processing (e.g. multiple analyzers, logging + processing + analytics).

## Agent Chain (Sequential)

Events flow through a series of agents. Each agent transforms and forwards to the next channel.

```ts
const main = mainChannel('main');
const processing = createChannel('processing');
const client = createChannel('client').sink(sink.httpStream());

registerAgent(plannerAgent).subscribe(main).publishTo(processing);
registerAgent(executorAgent).subscribe(processing).publishTo(client);
```

Use for multi-step workflows (e.g. plan → execute → respond).

## Loopback / Emit-and-Await

Use `emitAndAwait` when an agent or tool needs to emit an event and pause until a later event on the network satisfies a matcher.

```ts
.logic(async ({ triggerEvent, emitAndAwait, emit }) => {
  const reply = await emitAndAwait(
    taskRequested.make({ id: triggerEvent.payload.id }),
    (event) => event.name === 'task-result',
    { timeout: '30 seconds' },
  );

  emit(finalEvent.make({ result: reply.payload }));
})
```

Each call is scoped with a generated `meta.correlationId`, and the matcher only runs for events that carry that same correlation id. Since emitted events copy the triggering event meta, a worker agent that handles the request and emits a reply will automatically echo the correlation id.

The reply must be produced by a different subscriber while the caller is waiting. If an agent emits a request and waits for a reply that only the same blocked invocation can produce, the wait will time out.

## Join (Multiple Inputs)

To "join" multiple event streams, create an agent that listens to multiple event types and combines them. Use `listensTo([eventA, eventB])` — the agent runs when either event arrives. For true join semantics (wait for both), you may need to implement state in the agent (e.g. store partial results, emit only when both have arrived).

## Retries

m4trix does not provide built-in retry logic. Implement retries inside your agent logic:

```ts
.logic(async ({ triggerEvent, emit }) => {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await doWork(triggerEvent.payload);
      emit({ name: 'response', payload: { result, done: true } });
      return;
    } catch (e) {
      if (i === maxRetries - 1) {
        emit({ name: 'error', payload: { message: String(e) } });
      }
    }
  }
})
```

For more patterns, see [Networks](../concepts/networks.md) and [AgentNetwork API](../api-reference/agent-network.md).
