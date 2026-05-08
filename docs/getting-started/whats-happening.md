# What's Happening (Mental Model)

Here's the mental model for how a request flows through m4trix:

## Flow Overview

1. **HTTP Request** — A client sends a POST (or GET) to your exposed endpoint.
2. **expose()** — Extracts the JSON payload, runs auth (if configured), and publishes a **start event** to the main channel.
3. **Main Channel** — Events enter here. Agents subscribed to this channel receive the event.
4. **Agent(s)** — Logic runs. The agent reads `triggerEvent.payload`, does work (e.g. calls an LLM), and **emits** new events.
5. **Client Channel** — Emitted events are published to channels the agent is bound to. The client channel has an `httpStream()` sink, so events are streamed as SSE to the browser.
6. **Browser** — Receives SSE events and can render them in real time.

## Key Ideas

- **Events** are typed messages. Schemas are validated at runtime via Effect.
- **Channels** route events. Agents subscribe to channels (input) and publish to channels (output).
- **Sinks** determine how events leave the system — e.g. `httpStream()` for SSE, or Kafka for event backends.
- **AgentNetwork** wires everything: channels, agents, and the event plane.

## Diagram

```text
HTTP Request
    │
    ▼
┌─────────────────────┐
│   expose() / API    │  ← Auth, payload extraction
└────────┬────────────┘
         │ start event
         ▼
┌─────────────────────┐
│    Main Channel     │  ← Events enter here
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│      Agent(s)       │  ← Logic runs, emits new events
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│   Client Channel    │  ← sink: httpStream()
└────────┬────────────┘
         │ SSE
         ▼
      Browser
```

## Next

- [Next Steps](next-steps.md) — Where to go from here
