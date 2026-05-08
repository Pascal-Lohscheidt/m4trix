# Deployment (Next.js, Express, Edge)

## Next.js

Deploy a Next.js app with m4trix API routes as usual. The `NextEndpoint` handler works with:

- **Vercel** — Serverless functions; streaming is supported
- **Node.js server** — `next start` or custom server
- **Docker** — Build and run the Next.js app in a container

Ensure your runtime supports streaming responses (Vercel and Node.js do). For Edge, see below.

## Express

Use `ExpressEndpoint` for traditional Express apps:

```ts
import express from 'express';
import { ExpressEndpoint } from '@m4trix/core/matrix';

const app = express();
app.use(express.json());

const handler = ExpressEndpoint.from(api).handler();
app.get('/api/stream', handler);
app.post('/api/stream', handler);

app.listen(3000);
```

- Apply `body-parser` (or `express.json()`) for POST payloads
- The handler sets SSE headers and handles client disconnect

## Edge / Serverless

m4trix uses Effect and Node.js-style streams. Edge runtimes (Vercel Edge, Cloudflare Workers) may have limitations:

- **Vercel Edge** — Check compatibility with Effect and `ReadableStream`; some APIs may need adaptation
- **Cloudflare Workers** — Would require adapter work for the event plane and streams

For production, **Node.js serverless** (e.g. Vercel Node.js runtime) or **Express on a long-lived server** are the most tested paths.

## Environment Variables

Store API keys and secrets in environment variables. Access them in agent logic:

```ts
.logic(async ({ triggerEvent, emit }) => {
  const apiKey = process.env.OPENAI_API_KEY;
  // ...
})
```

Never commit secrets. Use your platform's secret management (Vercel, AWS Secrets Manager, etc.).
