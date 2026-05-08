# Patterns: Request/Response, Fan-Out, Join, Retries

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
