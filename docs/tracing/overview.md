---
title: "Overview"
---

`@m4trix/tracing` records LangGraph and LangChain-style callback runs into a portable trace store. Pair it with `@m4trix/trace-viewer` to inspect traces locally in a browser.

Use it when you want to:

- Debug nested agent, chain, model, tool, and retriever calls
- Keep model inputs and outputs available after a run finishes
- Attach run metadata such as project, environment, tenant, or experiment labels
- Build a custom trace backend behind the same storage interfaces
- View local filesystem traces without wiring up hosted observability first

## Core Model

Tracing is made of four pieces:

1. **Tracer** implements callback handlers and turns start/end/error events into trace runs.
2. **TraceStore** persists trace structure separately from larger JSON payloads.
3. **Adapters** decide where trace metadata and payloads are stored.
4. **TraceViewerApi** reads stored traces and returns list, tree, and payload data for a UI.

```ts
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  TraceStore,
  Tracer,
} from '@m4trix/tracing';

const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: './tmp/traces' }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: './tmp/traces' }),
});

const tracer = Tracer.from(traceStore);

await graph.invoke(input, {
  callbacks: [tracer],
  metadata: {
    projectId: 'support-agent',
    env: 'dev',
  },
});

await tracer.flush();
```

## Package Exports

Import tracing primitives from `@m4trix/tracing`:

- `Tracer`
- `TraceStore`
- `TraceViewerApi`
- `FsStructureStoreAdapter`, `FsPayloadStoreAdapter`
- `Trace`, `TraceRun`, `TraceRunNode`
- `TraceStatus`, `TraceRunType`, `TraceTokens`, `TraceMetadata`
- `StructureStoreAdapter`, `PayloadStoreAdapter`, `ListTracesQuery`

Import viewer helpers from `@m4trix/trace-viewer`:

- `createFsTraceViewerApi`
- `startTraceViewerServer`
- `appRouter`, `AppRouter`, `TraceViewerContext`
- `parseCliArgs`, `cliHelpText`

## Example Project

The repository includes a LangGraph example at `examples/tracing-example`. It writes filesystem traces to `tmp/tracing-example` and can be inspected with the trace viewer:

```bash
pnpm --filter @examples/tracing-example example
pnpm exec m4trix-trace-viewer --adapter fs --path ./tmp/tracing-example --port 4319
```

