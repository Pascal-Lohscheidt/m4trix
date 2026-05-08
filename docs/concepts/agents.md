# Agents (Logic + Lifecycle)

Agents are units of work. You build them with the `AgentFactory` builder, declaring which events they listen to, which events they emit, and the async logic that runs when triggered.

## Basic Usage

{% code title="echo-agent.ts" %}
```ts
import { AgentFactory, AgentNetworkEvent, S } from '@m4trix/core/matrix';

const inputEvent = AgentNetworkEvent.of('user-input', S.Struct({ text: S.String }));
const outputEvent = AgentNetworkEvent.of('agent-output', S.Struct({ reply: S.String }));

const echoAgent = AgentFactory.run()
  .listensTo([inputEvent])
  .emits([outputEvent])
  .logic(async ({ triggerEvent, emit }) => {
    emit({
      name: 'agent-output',
      payload: { reply: `Echo: ${triggerEvent.payload.text}` },
    });
  })
  .produce({});
```
{% endcode %}

## Lifecycle

1. **Definition** — `AgentFactory.run()` starts the builder; `.listensTo()`, `.emits()`, `.logic()` configure the agent.
2. **Production** — `.produce(params)` finalizes and returns an `Agent` instance.
3. **Registration** — The agent is registered in a network via `registerAgent(agent).subscribe(...).publishTo(...)`.
4. **Execution** — When a matching event arrives on a subscribed channel, the logic runs. The agent can emit events to its publish channels.

## Type Safety

The builder provides end-to-end type inference:

* **Trigger events** — `triggerEvent` in `.logic()` is typed as a union of all `listensTo` event envelopes
* **Emit payloads** — The `emit()` function only accepts payloads matching declared `emits` events
* **Parameters** — `params` in `.logic()` matches the schema from `.params()`

## Catch-All Agents

If you omit `.listensTo()`, the agent receives **every event** on its subscribed channels. Useful for logging, monitoring, or routing.

```ts
const loggerAgent = AgentFactory.run()
  .logic(async ({ triggerEvent }) => {
    console.log('Event received:', triggerEvent);
  })
  .produce({});
```

See [AgentFactory API](../api-reference/agent-factory.md) for the full builder reference.
