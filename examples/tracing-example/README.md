# Tracing example

Runs a LangGraph workflow that exercises a more varied trace tree:

- a parent graph with conditional routing
- a reusable `research_graph` subgraph with parallel research branches
- a reusable `writing_graph` subgraph for drafting and review
- structured mock tools for documentation search, repository search, and quality scoring

The example writes traces to the repo-level directory **`tmp/tracing-example`** using filesystem adapters. It also records **mock token usage** on tool outputs and fake `chat_model` spans so you can try the trace viewer **LangGraph** profile (subtree token badges and header aggregates).

In the viewer: enable **LangGraph** in settings, select that profile, turn on **Auto load payloads** (or use **Load trace payloads**), then expand the run tree.

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

If `pnpm exec` does not resolve the binary, use:

```bash
pnpm --filter @m4trix/trace-viewer exec m4trix-trace-viewer --adapter fs --path ./tmp/tracing-example --port 4319
```

Open **http://127.0.0.1:4319**.
