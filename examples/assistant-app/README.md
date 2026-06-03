# Assistant App

Terminal assistant example powered by `@m4trix/core` agent network, exposed over **tRPC streaming procedures** (async iterator + `httpBatchStreamLink`), with `@m4trix/tracing` via core's `NetworkTracer` (`toM4trixTracer()`).

## Prerequisites

- Node.js 20+
- `pnpm install` from the monorepo root
- After pulling changes to `@m4trix/core`, rebuild it: `pnpm --filter @m4trix/core build` (the example imports the package `dist/`, not TypeScript source)
- `OPENAI_API_KEY` in a `.env` file
- `TAVILY_API_KEY` for web search tools (`assistant-agent.ts` / `assistant-agent-test.ts`)

## Quick start

```bash
cp .example.env .env
# Edit .env and set OPENAI_API_KEY (and TAVILY_API_KEY for web search)

# From the monorepo root, install LangChain deps for this example:
pnpm --filter assistant-app add langchain @langchain/core @langchain/openai

pnpm --filter assistant-app dev

# Optional: server startup message, ready banner, trace console output, Node warnings
pnpm --filter assistant-app dev -- --with-logs
```

The test network agent uses LangChain [`createAgent`](https://docs.langchain.com/oss/javascript/langchain/overview) (ReAct) with `ChatOpenAI` instead of the OpenAI SDK directly. M4trix tools (`webSearch`, `readWebPage`) are bridged into LangChain via `src/network/langchain/m4trix-tool-bridge.ts`.

Or after building:

```bash
pnpm --filter assistant-app build
pnpm --filter assistant-app start
```

## Architecture

```
CLI (readline REPL)
  └─ spawns server subprocess
       └─ tRPC standalone server (/trpc/)
            └─ chat.send (streaming mutation, async generator)
                 └─ stream-bridge.ts → network.expose().createStream()
                      └─ AgentNetwork (single streaming assistant agent)
```

The CLI spawns the agent server as a child process, waits for `health.ping`, then opens an interactive prompt. Each message calls `chat.send` and streams events with `for await`.

## tRPC streaming (not SSE subscriptions)

This example uses tRPC v11 **streaming procedures**:

| Piece | Choice |
|-------|--------|
| Server | `.mutation(async function* …)` yielding agent events |
| Client | `httpBatchStreamLink` only |
| Wire format | Chunked HTTP + `application/jsonl` |

It does **not** use tRPC subscriptions, `httpSubscriptionLink`, or EventSource.

## `@m4trix/core` has no tRPC adapter

Core exposes networks via SSE adapters (`NextEndpoint`, `ExpressEndpoint`). This example adds a **custom bridge** in [`src/server/stream-bridge.ts`](src/server/stream-bridge.ts) that calls `network.expose().createStream()` programmatically and yields envelopes into the tRPC async generator.

## Tracing

Core defines a pluggable `NetworkTracer` interface. This example wires `@m4trix/tracing` at network setup:

```ts
AgentNetwork.setup(
  ({ registerAgent }) => { /* ... */ },
  {
    consoleTracing: true,
    networkTracer: toM4trixTracer(tracer),
  },
);
```

Agents use `tracing.startRun('llm', ...)` in `.logic()` instead of calling the tracing package directly. Traces are written to `tmp/assistant-app-traces/`.

Inspect traces:

```bash
pnpm exec m4trix-trace-viewer --path examples/assistant-app/tmp/assistant-app-traces
```

## Comparison

| Example | Transport | UI |
|---------|-----------|-----|
| [`core-example`](../core-example) | SSE (Next.js) | Web chat |
| **assistant-app** | tRPC JSONL stream | Terminal CLI |

## Scripts

| Script | Description |
|--------|-------------|
| `dev` | Run CLI in dev mode (spawns server via `tsx`) |
| `build` | Bundle CLI + server with tsup |
| `start` | Run built CLI |

## Options

```
m4trix-assistant [--port <n>]
```

Default port: `4320`.
