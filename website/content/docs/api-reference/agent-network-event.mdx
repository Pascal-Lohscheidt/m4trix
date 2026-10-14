---
title: "AgentNetworkEvent"
---

`AgentNetworkEvent` defines typed events with schema validation via [Effect Schema](https://effect.website/).

## Creating Events

```ts
AgentNetworkEvent.of(name, schema)
```

```ts
const myEvent = AgentNetworkEvent.of('my-event', S.Struct({ value: S.Number }));
```

### Transient events

```ts
const tokenDelta = AgentNetworkEvent.of('token-delta', S.Struct({ text: S.String }), {
  transient: true,
});
```

`transient` (default `false`) marks events that may be dropped under back-pressure, such as token deltas or progress ticks. When an agent's mailbox for a run is full, a new transient event replaces the oldest buffered transient event instead of making the publisher wait (and is dropped if there is none to replace). Durable events always wait for room. Transient events are streamed and traced but never written to the network's store, so they never appear in `ctx.history`. The flag is readable as `myEvent.transient`.

A plane knows an event is transient when an agent or aggregator started on it declares its definition (with `transient: true`) in `listensTo` or `emits`. An event only published from outside (e.g. `plane.publish`) whose definition no agent or aggregator of the network declares is treated as durable.

## Methods

### `.make(payload)`

Creates an unbound event (name + payload) for use with `emit`. Meta is injected by the runtime when emitted.

```ts
emit(myEvent.make({ value: 42 }));
```

### `.makeBound(meta, payload)`

Creates a full envelope for tests or manual triggers. Sync, throws on invalid data.

```ts
const envelope = myEvent.makeBound(
  { runId: crypto.randomUUID() },
  { value: 42 },
);
```

### `.makeEffect(payload)`

Effect version of `make`. Use in Effect pipelines.

### `.makeBoundEffect(meta, payload)`

Effect version of `makeBound`.

### `.decode(unknown)`

Decodes an unknown value into a validated event envelope. Useful for parsing incoming requests.

```ts
const result = Effect.runSync(myEvent.decode(rawData));
```

### `.is(value)`

Type guard that checks whether an unknown value matches this event's shape.

```ts
if (myEvent.is(someValue)) {
  console.log(someValue.payload.value);
}
```

## Event Envelope

Every event has:

```ts
{
  name: string;           // Event name
  meta: {
    runId: string;
    contextId: string;
    eventId?: string;       // Unique id; set on publish when missing
    correlationId?: string; // Shared by an emitAndAwait request and its replies
    causationId?: string;   // eventId of the event whose handling emitted this one
    ts?: number;            // Publish time (epoch ms); set on publish when missing
    depth?: number;         // Hops from the run's start event (0); checked against maxDepth
  };
  payload: T;            // Validated against schema
}
```

## See Also

- [Events (Concepts)](../concepts/events.md)
- [Channels](channel-api.md)
