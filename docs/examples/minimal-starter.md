# Minimal Starter

The simplest m4trix setup: one agent, one request event, one response event, exposed as an SSE endpoint.

## Location

Clone the repo and see:

```
examples/core-example/
```

## What It Does

- Defines `MessageEvent` (request) and response events
- Creates a single agent that echoes or processes the message
- Wires the agent to main → client channels
- Exposes the network as a Next.js API route

## Run It

```bash
cd examples/core-example
pnpm install
pnpm dev
```

Then `POST` to `http://localhost:3000/api/reasoning` with a JSON body like `{"request": "Hello"}`.

## Key Files

- `app/api/reasoning/events.ts` — Event definitions
- `app/api/reasoning/example-agent.ts` — Agent logic
- `app/api/reasoning/network.ts` — Network wiring
- `app/api/reasoning/route.ts` — Next.js route + expose config

## Next

- [Multi-Agent Workflow](multi-agent-workflow.md)
- [Hello World](../getting-started/hello-world.md)
