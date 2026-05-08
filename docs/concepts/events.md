# Events (Type System + Schema)

Events are typed messages that flow through the system. Each event has a **name**, a **payload schema** (validated at runtime via [Effect Schema](https://effect.website/)), and automatically-attached **metadata** (run ID, timestamps, correlation IDs).

## Defining Events

Use `AgentNetworkEvent.of()` to define an event with a name and a payload schema:

```ts
import { AgentNetworkEvent, S } from '@m4trix/core/matrix';

const userMessage = AgentNetworkEvent.of(
  'user-message',
  S.Struct({
    text: S.String,
    userId: S.optional(S.String),
  }),
);
```

The resulting event definition is a constant you reference throughout your code — in agent factories, network setup, and expose configuration.

## Event Envelope

Every event flowing through the system is wrapped in an envelope:

```ts
{
  name: 'user-message',        // Event name (literal type)
  meta: {
    runId: 'uuid-...',         // Unique run identifier
    contextId: '...',          // Optional context grouping
    correlationId: '...',      // Optional correlation chain
    causationId: '...',        // Optional cause tracking
    ts: 1700000000,            // Optional timestamp
  },
  payload: {
    text: 'Hello!',            // Validated against the schema
    userId: 'user-123',
  },
}
```

The `meta` fields are automatically managed by the runtime. You only need to provide the `name` and `payload` when emitting events from agents.

## API Summary

| Method | Description |
|--------|-------------|
| `AgentNetworkEvent.of(name, schema)` | Creates an event definition |
| `.make(payload)` | Creates an unbound event for `emit`; meta injected at runtime |
| `.makeBound(meta, payload)` | Creates full envelope for tests or manual triggers |
| `.makeEffect(payload)` | Effect version of `make` |
| `.makeBoundEffect(meta, payload)` | Effect version of `makeBound` |
| `.decode(unknown)` | Decodes unknown value into validated envelope |
| `.is(value)` | Type guard for event shape |

See [AgentNetworkEvent API](../api-reference/agent-network-event.md) for full details.
