# Networks (Wiring)

The `AgentNetwork` wires everything together. You declare channels, register agents with their subscriptions and publish targets, and the network manages the event plane at runtime.

## Setting Up a Network

```ts
import { AgentNetwork } from '@m4trix/core/matrix';

const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, sink, registerAgent }) => {
    const main = mainChannel('main');
    const client = createChannel('client').sink(sink.httpStream());

    registerAgent(myAgent).subscribe(main).publishTo(client);
  },
);
```

## Setup Context

| Tool | Description |
|------|-------------|
| `mainChannel(name)` | Designates the main channel where start events are published |
| `createChannel(name)` | Creates additional named channels |
| `sink` | Provides sink factories (e.g. `httpStream()`, `kafka()`) |
| `registerAgent(agent)` | Registers an agent and returns a binding builder |
| `spawner` | Creates a spawner for dynamic agent creation (multi-tenant) |

## Multi-Agent Patterns

### Agent Chain

Events flow through a series of agents:

```ts
registerAgent(plannerAgent).subscribe(main).publishTo(processing);
registerAgent(executorAgent).subscribe(processing).publishTo(client);
```

### Fan-Out

One event triggers multiple agents in parallel:

```ts
registerAgent(agentA).subscribe(main).publishTo(client);
registerAgent(agentB).subscribe(main).publishTo(client);
registerAgent(agentC).subscribe(main).publishTo(client);
```

### Multi-Channel Routing

Different agents on different channels:

```ts
registerAgent(routerAgent).subscribe(main).publishTo(internal);
registerAgent(workerAgent).subscribe(internal).publishTo(client);
registerAgent(loggerAgent).subscribe(main).subscribe(internal);
```

See [AgentNetwork API](../api-reference/agent-network.md) and [Patterns guide](../guides/patterns.md) for more.
