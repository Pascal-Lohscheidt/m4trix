---
title: "AgentFactory"
---

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

`.produce(params)` validates the params against this schema at runtime and hands the agent the decoded value (schema transformations applied); invalid params throw `AgentParamsError` with `issues: { path, message }[]`.

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

The declaration is enforced at runtime, not just in types, because emitted payloads often come from a model:

- `emit` throws, and `emitAndAwait` rejects with, `EmitValidationError` (`eventName`, `agentId`, `toolName?`, `reason`, `issues`) when the event is not declared (`reason: 'undeclared'`, also for reserved `m4trix:*` names), its payload fails the event's schema (`'invalid-payload'`, with `issues: { path, message }[]`), or none of the agent's publish channels accepts it (`'channel'`, see [`.events()`](channel-api.md#events)). The event is not published.
- The invocation fails with that error **even if the logic catches it**, so the network's `onAgentError` policy applies: under `'fail'` the run ends with `m4trix:run.failed`, `error.kind: 'invalid-emit'` and `error.event`; under `'continue'`, `m4trix:agent.error` is published. The client-facing message names the event and the offending paths, never the payload values.
- The published payload is the validated one: a value that already is exactly of the event's type (e.g. from `event.make()`) is published as is; anything else, such as raw model output, is decoded with the schema, so transformations apply and unknown properties are dropped.
- **An agent without `.emits()` may emit nothing.**
- Tools are checked against their own `.emits([...])`; an agent does not need to repeat its tools' events. A tool's invalid emit is not a tool error: it is not retried, `executeForModel` does not turn it into a model result, and it fails the calling agent's invocation like the agent's own.

### `.logic(fn)`

The core handler. Receives:

- **`params`** — Resolved parameters from `.produce()`
- **`triggerEvent`** — Full envelope `{ name, meta, payload }` that triggered the agent
- **`emit(event)`** — Function to emit events, typed to declared `.emits()` events and checked against them at runtime (see [`.emits()`](#emitsevents))
- **`history`** — The durable event history of the run and its conversation, read on demand: `history.run()` and `history.context({ limit?, before? })` (paged, oldest first). Scoped to the run's principal; transient events are never in it. See [Event history and stores](agent-network.md#event-history-and-stores)
- **`principal`** — Who the run acts for, as `auth` returned it (`{ id, ...claims }`); `undefined` for anonymous runs. Tools get it as `principal` too
- **`signal`** — `AbortSignal` aborted when the run ends or the client disconnects. Pass it to `fetch` and LLM calls; tools and skills receive it as `signal` too
- **`complete()`** — Ends the run as completed, after the events this invocation already emitted
- **`fail(error)`** — Ends the run as failed with `error`, whatever the network's `onAgentError` policy
- **`reportUsage(usage)`** — Records what a model call used (`{ inputTokens?, outputTokens?, totalTokens?, cacheReadTokens?, cacheWriteTokens?, costUsd?, model? }`) on the run: summed per run and model, passed to the tracer, included in the run-end event and checked against `maxTokens` / `maxCostUsd`. Tools get it as `reportUsage` too. A no-op outside a network

```ts
.logic(async ({ params, triggerEvent, emit }) => {
  emit({ name: 'agent-output', payload: { reply: '...' } });
})
```

### `.concurrency(limit)`

Caps how many invocations of the agent run at once across all runs of a network, e.g. to stay within an LLM provider's rate limit. `limit` is a positive integer or `Infinity`; the default is unbounded.

```ts
const writer = AgentFactory.run()
  .listensTo([draftRequested])
  .emits([draftReady])
  .concurrency(20)
  .logic(async ({ triggerEvent, emit }) => { /* ... */ });
```

Within one run an agent always handles its events one at a time, in the order they were published, even when it subscribes to several channels (an event published to two of them arrives once). Different runs never wait on each other, apart from this cap. Invocations waiting for the cap count as pending work for the run, so they don't trip its `idleTimeout`.

### `.produce(params)`

Finalizes the builder and returns an `Agent` instance. The `params` argument must match the schema from `.params()`; it is validated and decoded, and invalid params throw `AgentParamsError`.

```ts
const agent = builder.produce({ model: 'gpt-4o' });
```

Outside a network, `agent.invoke({ signal })` passes your signal through, `complete()` does nothing and `fail(error)` makes `invoke()` reject with `error`. Emits are validated there too: your `emit` callback receives decoded events, and an invalid emit makes `invoke()` reject with `EmitValidationError`.

## Type Safety

- `triggerEvent` is a union of all `listensTo` event envelopes
- `emit()` only accepts payloads matching declared `emits` events, and checks them again at runtime
- `params` matches the schema from `.params()`, and is validated against it by `.produce()`

## See Also

- [Agents (Concepts)](../concepts/agents.md)
- [AgentNetworkEvent](agent-network-event.md)
- [AgentNetwork](agent-network.md)
