# Express

Use the `ExpressEndpoint` adapter to expose your agent network as an Express route.

## Setup

1. Install m4trix and Express:

```bash
pnpm add @m4trix/core express
```

2. Create your Express app:

```ts
import express from 'express';
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  ExpressEndpoint,
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

const app = express();
app.use(express.json());

const handler = ExpressEndpoint.from(api).handler();
app.get('/api/stream', handler);
app.post('/api/stream', handler);

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
```

## Important

- **body-parser** — Use `express.json()` (or equivalent) so POST bodies are parsed. The handler reads `req.body` for the payload.
- **Client disconnect** — The handler listens for the `close` event and cleans up the stream.
- **Compression** — If using compression middleware, the handler calls `res.flush()` when available for better streaming.
