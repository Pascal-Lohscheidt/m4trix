# @m4trix/tracing

A lightweight tracing layer for LangGraph and LangChain-style applications. It stores trace
structure separately from large payloads so traces can be written locally, viewed from a mounted
Docker volume, or backed by custom storage adapters.

## Storage Model

```txt
LangGraph / LangChain-style run
            |
            v
        Tracer  (callback-shaped handler)
            |
            v
        TraceStore
        /        \
       v          v
StructureStoreAdapter    PayloadStoreAdapter
(small queryable rows)   (large JSON blobs, returns refs)
            ^
            |
        TraceViewerApi  (read-only)
```

- The structure store keeps trace summaries and per-run spans.
- The payload store keeps inputs, outputs, and event streams, returning opaque refs.
- The same `TraceStore` is used by the writer (`Tracer`) and reader (`TraceViewerApi`).

## Install

```sh
pnpm add @m4trix/tracing
```

## Core Types

```ts
export type TraceRun = {
  schemaVersion: 1;
  traceId: string;
  runId: string;
  parentRunId?: string;
  type:
    | "agent" | "chain" | "llm" | "chat_model"
    | "tool" | "retriever" | "embedding"
    | "prompt" | "parser"
    | (string & {});
  name: string;
  status: "running" | "success" | "error";
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  tokens?: { input: number; output: number; cached?: number };
  costUsd?: number;
  error?: { message: string; type?: string };
  inputRef?: string;
  outputRef?: string;
  eventsRef?: string;
  metadata?: Record<string, string | number | boolean>;
  extra?: Record<string, unknown>;
};

export type Trace = {
  schemaVersion: 1;
  traceId: string;
  rootRunId: string;
  projectId?: string;
  name: string;
  status: "running" | "success" | "error";
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  tokens?: { input: number; output: number };
  costUsd?: number;
  runCount: number;
  metadata?: Record<string, string | number | boolean>;
};
```

## Composition

```ts
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  TraceStore,
  TraceViewerApi,
  Tracer,
} from "@m4trix/tracing";

const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: "./.traces" }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: "./.traces" }),
});

const tracer = Tracer.from(traceStore);
const traceViewerApi = TraceViewerApi.from(traceStore);
```

## Writing Traces

`Tracer` implements the common LangChain callback method names (`handleChainStart`,
`handleChainEnd`, `handleToolStart`, `handleToolEnd`, `handleLLMStart`, `handleLLMEnd`, error
handlers, and retriever handlers). It does not currently import LangChain at runtime, so it can be
used as a compatible callback-shaped object without forcing a LangChain dependency.

```ts
await graph.invoke(input, {
  callbacks: [tracer],
  metadata: { projectId: "my-app", env: "dev" },
});

await tracer.flush();
```

Always `await tracer.flush()` on short-lived processes before exit.

## Reading Traces

```ts
await traceViewerApi.listTraces({ projectId: "my-app", limit: 25 });
await traceViewerApi.getTrace(traceId);      // { trace, runs } | null
await traceViewerApi.getTraceTree(traceId);  // { trace, root: TraceRunNode } | null
await traceViewerApi.getPayload(ref);        // resolves any JSON payload ref
```

## Filesystem Adapters

The bundled filesystem adapters write under one configurable directory:

```txt
.traces/
  traces/
    {traceId}/
      trace.json
      runs.ndjson
      payloads/
        {runId}/
          input.json
          output.json
          events.ndjson
```

`FsStructureStoreAdapter.listTraces` scans `traces/*/trace.json`, applies simple filters, and
returns traces newest-first. It is suitable for local development and small datasets.

`FsPayloadStoreAdapter` returns refs relative to the configured root, for example
`traces/{traceId}/payloads/{runId}/input.json`. JSON refs can be resolved with
`TraceViewerApi.getPayload(ref)`. Stream refs can be written and read directly through
`putStream`/`getStream`.

## Adapter Interfaces

```ts
export type StructureStoreAdapter = {
  upsertTrace(trace: Trace): Promise<void>;
  upsertRun(run: TraceRun): Promise<void>;
  upsertRunBatch?(runs: TraceRun[]): Promise<void>;
  getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null>;
  listTraces(query?: {
    projectId?: string;
    status?: Trace["status"];
    startAfter?: string;
    startBefore?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ traces: Trace[]; nextCursor?: string }>;
};

export type PayloadStoreAdapter = {
  putJson(path: string, value: unknown): Promise<string>;
  getJson<T = unknown>(ref: string): Promise<T>;
  putStream?(path: string, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string>;
  getStream?(ref: string): Promise<ReadableStream<Uint8Array>>;
};
```

## Out of Scope

- Sampling and rate limiting.
- PII redaction.
- Multi-tenant auth and authorization in the viewer.
- Retention / TTL.
- Production-scale querying in the filesystem structure adapter.
