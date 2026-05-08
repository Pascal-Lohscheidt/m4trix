# Types / Advanced Generics

m4trix provides full TypeScript inference from event schemas through agent logic to HTTP responses.

## Event Inference

When you define events with `AgentNetworkEvent.of()`, the payload type is inferred from the Effect schema:

```ts
const req = AgentNetworkEvent.of('req', S.Struct({ query: S.String }));
// req payload type: { query: string }
```

## Agent Logic Inference

In `.logic()`, `triggerEvent` is a union of all `listensTo` event envelopes:

```ts
AgentFactory.run()
  .listensTo([eventA, eventB])
  .emits([outEvent])
  .logic(async ({ triggerEvent, emit }) => {
    // triggerEvent: { name: 'a', meta, payload: { x: number } }
    //             | { name: 'b', meta, payload: { y: string } }
    if (triggerEvent.name === 'a') {
      emit({ name: 'out', payload: { result: String(triggerEvent.payload.x) } });
    } else {
      emit({ name: 'out', payload: { result: triggerEvent.payload.y } });
    }
  });
```

## Emit Typing

The `emit()` function only accepts events declared in `.emits()`. TypeScript will error if you emit an undeclared event or wrong payload shape.

## Channel Names

Channel names use a branded type (`ChannelName`) and must be kebab-case. This is enforced at runtime.

## Effect Integration

m4trix uses [Effect](https://effect.website/) for schema validation and concurrency. The event plane runs inside an Effect scope. For advanced use, you can compose with Effect's `Effect` type and use `.makeEffect()` / `.makeBoundEffect()` for event creation.
