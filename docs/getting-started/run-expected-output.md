# Run + Expected Output

## Running the Hello World Example

1. Create a Next.js project (or use an existing one):

```bash
npx create-next-app@latest my-m4trix-app
cd my-m4trix-app
```

2. Install m4trix:

```bash
pnpm add @m4trix/core
```

3. Create `app/api/chat/route.ts` with the [Hello World](hello-world.md) code.

4. Start the dev server:

```bash
pnpm dev
```

5. Call the API:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"query": "Hello"}'
```

## Expected Output

You'll receive an SSE stream:

```text
event: agent-response
data: {"name":"agent-response","meta":{"runId":"..."},"payload":{"answer":"You asked: Hello","done":true}}
```

Or from a browser, use `EventSource` or fetch with `ReadableStream` to consume the stream.

## Next

- [What's Happening (Mental Model)](whats-happening.md) — Understand the flow
