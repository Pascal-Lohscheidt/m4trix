# AgentFactory

The `AgentFactory` is a fluent builder for creating type-safe agents. It provides full TypeScript inference from trigger events through to emitted events.

## Entry Point

```ts
AgentFactory.run()
```

Creates a fresh builder with no configuration.

## Builder Methods

### `.params(schema)`

Defines the parameter schema for the agent. Parameters are static configuration passed when producing the agent.

```ts
.params(S.Struct({ model: S.String, temperature: S.Number }))
```

### `.listensTo(events)`

Declares which event types trigger this agent. Accepts an array of `AgentNetworkEventDef`. Can be called multiple times — events accumulate.

```ts
.listensTo([eventA, eventB])
.listensTo([eventC])  // now listens to A, B, and C
```

Omit to create a catch-all agent that receives every event on subscribed channels.

### `.emits(events)`

Declares which event types this agent can emit. Also accumulates across multiple calls.

```ts
.emits([responseEvent, errorEvent])
```

### `.logic(fn)`

The core handler. Receives:

- **`params`** — Resolved parameters from `.produce()`
- **`triggerEvent`** — Full envelope `{ name, meta, payload }` that triggered the agent
- **`emit(event)`** — Function to emit events, typed to declared `.emits()` events

```ts
.logic(async ({ params, triggerEvent, emit }) => {
  emit({ name: 'agent-output', payload: { reply: '...' } });
})
```

### `.produce(params)`

Finalizes the builder and returns an `Agent` instance. The `params` argument must match the schema from `.params()`.

```ts
const agent = builder.produce({ model: 'gpt-4o' });
```

## Type Safety

- `triggerEvent` is a union of all `listensTo` event envelopes
- `emit()` only accepts payloads matching declared `emits` events
- `params` matches the schema from `.params()`

## See Also

- [Agents (Concepts)](../concepts/agents.md)
- [AgentNetworkEvent](agent-network-event.md)
- [AgentNetwork](agent-network.md)
