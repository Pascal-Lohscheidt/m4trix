---
icon: keyboard-brightness
---

# Hello World

Copy and paste this minimal example into a Next.js API route (e.g. `app/api/chat/route.ts`):

```ts
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  NextEndpoint,
  S,
} from '@m4trix/core/matrix';

// 1. Define events
const requestEvent = AgentNetworkEvent.of(
  'user-request',
  S.Struct({ query: S.String }),
);

const responseEvent = AgentNetworkEvent.of(
  'agent-response',
  S.Struct({ answer: S.String, done: S.Boolean }),
);

// 2. Create an agent
const myAgent = AgentFactory.run()
  .listensTo([requestEvent])
  .emits([responseEvent])
  .logic(async ({ triggerEvent, emit }) => {
    emit({
      name: 'agent-response',
      payload: {
        answer: `You asked: ${triggerEvent.payload.query}`,
        done: true,
      },
    });
  })
  .produce({});

// 3. Wire the network
const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, sink, registerAgent }) => {
    const main = mainChannel('main');
    const client = createChannel('client').sink(sink.httpStream());
    registerAgent(myAgent).subscribe(main).publishTo(client);
  },
);

// 4. Expose as an API
const api = network.expose({
  protocol: 'sse',
  select: { channels: 'client' },
  startEventName: 'user-request',
});

export const GET = NextEndpoint.from(api).handler();
export const POST = NextEndpoint.from(api).handler();
```

## What This Does

1. **Events** — `requestEvent` and `responseEvent` define typed messages with schema validation.
2. **Agent** — `myAgent` listens for `user-request`, runs logic, and emits `agent-response`.
3. **Network** — The main channel receives requests; the client channel streams responses via HTTP.
4. **API** — `expose()` turns the network into an SSE endpoint; `NextEndpoint` adapts it for Next.js.

## Next

* [Run + Expected Output](run-expected-output.md) — How to run and what you'll see
