# Testing (Unit + Integration + Replay)

## Unit Testing Agents

Test agent logic in isolation by calling the logic with mock trigger events. Use `makeBound` to create full event envelopes:

```ts
import { AgentNetworkEvent, S } from '@m4trix/core/matrix';

const requestEvent = AgentNetworkEvent.of('user-request', S.Struct({ query: S.String }));
const responseEvent = AgentNetworkEvent.of('agent-response', S.Struct({ answer: S.String }));

const envelope = requestEvent.makeBound(
  { runId: crypto.randomUUID() },
  { query: 'Hello' },
);

// Call your agent's logic (you may need to extract it for testing)
const emitted: unknown[] = [];
const emit = (e: unknown) => emitted.push(e);
await myAgentLogic({ triggerEvent: envelope, emit, params: {} });

expect(emitted).toHaveLength(1);
expect(emitted[0]).toMatchObject({ name: 'agent-response', payload: { answer: expect.any(String) } });
```

## Integration Testing the Network

Run the network inside an Effect scope and publish events programmatically:

```ts
import { Effect } from 'effect';

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const plane = yield* network.run();
      const main = network.getMainChannel()!;
      // Publish a start event, collect from client channel, assert
    }),
  ),
);
```

## Replay

For replay-based testing, store event sequences (e.g. from a run artifact) and replay them through the network. Use `makeBound` or `decode` to reconstruct envelopes from stored JSON.

## Evals

Use `@m4trix/evals` for repeatable evaluation runs. See [Eval Harness](../examples/eval-harness.md) and the evals package docs.
