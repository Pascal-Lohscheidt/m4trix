# Multi-Agent Workflow

Chain multiple agents so events flow through a pipeline: request → planner → executor → client.

## Pattern

```ts
const main = mainChannel('main');
const processing = createChannel('processing');
const client = createChannel('client').sink(sink.httpStream());

registerAgent(plannerAgent).subscribe(main).publishTo(processing);
registerAgent(executorAgent).subscribe(processing).publishTo(client);
```

## Example Structure

Create two (or more) agents with compatible events:

1. **Planner** — Listens to `request`, emits `plan-ready` with a plan payload
2. **Executor** — Listens to `plan-ready`, emits `agent-response` with the result

Each agent is built with `AgentFactory` and registered with `subscribe`/`publishTo` to form the chain.

## Location

The [core-example](minimal-starter.md) can be extended to add a second agent. See [Patterns: Agent Chain](../guides/patterns.md) for the full pattern.

## Next

- [Patterns](../guides/patterns.md)
- [Networks](../concepts/networks.md)
