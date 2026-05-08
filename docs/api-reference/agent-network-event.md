# AgentNetworkEvent

`AgentNetworkEvent` defines typed events with schema validation via [Effect Schema](https://effect.website/).

## Creating Events

```ts
AgentNetworkEvent.of(name, schema)
```

```ts
const myEvent = AgentNetworkEvent.of('my-event', S.Struct({ value: S.Number }));
```

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
    contextId?: string;
    correlationId?: string;
    causationId?: string;
    ts?: number;
  };
  payload: T;            // Validated against schema
}
```

## See Also

- [Events (Concepts)](../concepts/events.md)
- [Channels](channel-api.md)
