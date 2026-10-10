---
title: "Hello World"
icon: keyboard
---

Copy and paste this minimal example into a Next.js API route (e.g. `app/api/chat/route.ts`):

```ts
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  NextEndpoint,
  registerSSEStream,
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
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(myAgent).subscribe(mainChannel).publishTo(client);
    endsOn(responseEvent); // the run, and the response, end with the answer
  },
);

// 4. Expose as an API
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [requestEvent],
  }),
);

export const GET = NextEndpoint.from(api).handler();
export const POST = NextEndpoint.from(api).handler();
```

## What This Does

1. **Events** — `requestEvent` and `responseEvent` define typed messages with schema validation.
2. **Agent** — `myAgent` listens for `user-request`, runs logic, and emits `agent-response`.
3. **Network** — The main channel receives requests; the client channel streams responses via HTTP. `endsOn(responseEvent)` ends the run once the answer is published, so the response closes after `m4trix:run.completed`.
4. **API** — `expose()` turns the network into an SSE endpoint; `NextEndpoint` adapts it for Next.js.

## Next

* [Run + Expected Output](run-expected-output.md) — How to run and what you'll see
