# Next.js

Use the `NextEndpoint` adapter to expose your agent network as a Next.js App Router API route.

## Setup

1. Install m4trix:

```bash
pnpm add @m4trix/core
```

2. Create an API route (e.g. `app/api/chat/route.ts`):

```ts
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  NextEndpoint,
  S,
} from '@m4trix/core/matrix';

const requestEvent = AgentNetworkEvent.of('chat-request', S.Struct({ message: S.String }));
const responseEvent = AgentNetworkEvent.of('chat-response', S.Struct({ text: S.String, done: S.Boolean }));

const agent = AgentFactory.run()
  .listensTo([requestEvent])
  .emits([responseEvent])
  .logic(async ({ triggerEvent, emit }) => {
    emit({
      name: 'chat-response',
      payload: { text: `Echo: ${triggerEvent.payload.message}`, done: true },
    });
  })
  .produce({});

const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, sink, registerAgent }) => {
    const main = mainChannel('main');
    const client = createChannel('client').sink(sink.httpStream());
    registerAgent(agent).subscribe(main).publishTo(client);
  },
);

const api = network.expose({
  protocol: 'sse',
  select: { channels: 'client' },
  startEventName: 'chat-request',
});

const handler = NextEndpoint.from(api).handler();
export const GET = handler;
export const POST = handler;
```

## How It Works

1. Receives the incoming `Request`
2. Runs auth (if configured)
3. Extracts JSON payload from POST body (or empty object for GET)
4. Creates an SSE `Response` with streaming headers
5. Publishes the start event to the main channel
6. Streams matching events from the selected channels as SSE

## GET vs POST

- **GET** — Payload can be passed as query params (e.g. `?payload={"message":"Hi"}`). Useful for simple testing.
- **POST** — Payload in JSON body. Preferred for production.

## Full Example with OpenAI Streaming

See [IO + Adapters](../api-reference/io-adapters.md) for a complete Next.js streaming example with OpenAI.
