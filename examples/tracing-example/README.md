# Tracing example

Runs a small LangGraph workflow with **multiple nodes** (`planner` → `researcher` → `tool_lookup` → `summarizer` → `reviewer`) and writes traces to the repo-level directory **`tmp/tracing-example`** using filesystem adapters.

## Run the example

From the repo root:

```bash
pnpm --filter @examples/tracing-example run example
```

## View traces locally

Build and start the trace viewer (uses the same path):

```bash
pnpm --filter @m4trix/trace-viewer build
pnpm exec m4trix-trace-viewer --adapter fs --path ./tmp/tracing-example --port 4319
```

Open **http://127.0.0.1:4319**.
