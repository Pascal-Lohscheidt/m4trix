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
        TraceViewerApi  (read + annotation writes)
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
  annotation?: Record<string, unknown>;
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
  annotation?: Record<string, unknown>;
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

### LangGraph adapter

For an explicit LangGraph callback type, use `tracer.adapt(toLangGraph)`:

```ts
import { Tracer, toLangGraph } from "@m4trix/tracing";
// or: import { toLangGraph } from "@m4trix/tracing/adapters/langgraph";

const tracer = Tracer.from(traceStore);
const lgTracer = tracer.adapt(toLangGraph);

await graph.invoke(input, {
  callbacks: [lgTracer],
  metadata: { projectId: "my-app", env: "dev" },
});

await lgTracer.flush();
```

You can also pass `tracer` directly to `callbacks`; `adapt` only narrows the type and documents intent.

```ts
await graph.invoke(input, {
  callbacks: [tracer],
  metadata: { projectId: "my-app", env: "dev" },
});

await tracer.flush();
```

Always `await tracer.flush()` (or `await lgTracer.flush()` when using `adapt(toLangGraph)`) on short-lived processes before exit.

## Reading Traces

```ts
await traceViewerApi.listTraces({ projectId: "my-app", limit: 25 });
await traceViewerApi.getTrace(traceId);      // { trace, runs } | null
await traceViewerApi.getTraceTree(traceId);  // { trace, root: TraceRunNode } | null
await traceViewerApi.getPayload(ref);        // resolves any JSON payload ref

// Post-hoc review annotations (deep-merge by default)
await traceViewerApi.patchTraceAnnotation({
  traceId,
  annotation: { review: { status: "needs-followup", author: "pascal" } },
});
await traceViewerApi.patchRunAnnotation({
  traceId,
  runId,
  annotation: { note: "tool returned empty payload" },
  merge: false, // replace entire run annotation
});
```

## Annotations

`annotation` is a first-class JSON object on `Trace` and `TraceRun`, separate from scalar
`metadata` captured during execution. Use it for human review notes, labels, or workflow state
after a trace completes.

- `patchTraceAnnotation({ traceId, annotation, merge? })` — deep-merge by default
- `patchRunAnnotation({ traceId, runId, annotation, merge? })` — deep-merge by default
- `merge: false` replaces the whole annotation; `{}` with `merge: false` clears it

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

## AWS Adapters

For hosted storage, compose DynamoDB (structure) + S3 (payloads):

```ts
import {
  DynamoStructureStoreAdapter,
  S3PayloadStoreAdapter,
  TraceStore,
  resolveDynamoStructureStoreOptionsFromEnv,
  resolveS3PayloadStoreOptionsFromEnv,
} from "@m4trix/tracing";

const traceStore = TraceStore.of({
  structureStoreAdapter: new DynamoStructureStoreAdapter(
    resolveDynamoStructureStoreOptionsFromEnv(),
  ),
  payloadStoreAdapter: new S3PayloadStoreAdapter(
    resolveS3PayloadStoreOptionsFromEnv(),
  ),
});
```

Environment variables:

| Variable | Purpose |
|----------|---------|
| `TRACE_DYNAMO_TABLE` | DynamoDB table name |
| `TRACE_S3_BUCKET` | S3 bucket for payloads |
| `TRACE_S3_PREFIX` | Optional key prefix (default: none) |
| `AWS_REGION` | AWS region |
| `AWS_ENDPOINT_URL` | Optional (LocalStack) |

DynamoDB table schema (single-table):

| Attribute | Key | Notes |
|-----------|-----|-------|
| `pk` | partition | `traceId` |
| `sk` | sort | `TRACE` or `RUN#<runId>` |
| `listPk` | GSI `byStartTime` PK | `PROJECT#_all` on trace items |
| `listSk` | GSI `byStartTime` SK | trace `startTime` (ISO) |
| `trace` / `run` | — | full documents |

Payload refs remain logical paths like `traces/{traceId}/payloads/{runId}/input.json`.

## Trace Sidecar (filesystem → AWS)

For production deployments, write traces locally with the filesystem adapters and run
`m4trix-tracing-sidecar` in a companion container to replicate payloads to S3 and structure to
DynamoDB. The app avoids network latency and AWS credentials; the sidecar handles upload,
ordering, and cleanup.

```txt
App (FsStructure + FsPayload)  →  shared volume (/traces)
Sidecar (m4trix-tracing-sidecar)  →  S3 + DynamoDB
```

Replication order: **payloads first**, then **structure** (`trace.json`, `runs.ndjson`) once all
referenced payload refs are uploaded. Local payload files are deleted after a successful S3 put.
Progress is tracked in `{root}/.shipper/state.json` (sidecar-owned).

### CLI

After `pnpm --filter @m4trix/tracing build`:

```sh
TRACE_DYNAMO_TABLE=traces \
TRACE_S3_BUCKET=my-payloads \
AWS_REGION=us-east-1 \
  m4trix-tracing-sidecar --root ./.traces --once
```

Flags:

| Flag | Default | Purpose |
|------|---------|---------|
| `--root <dir>` | `TRACE_ROOT` or `/traces` | Local trace root |
| `--interval <dur>` | `2s` | Poll interval (`500ms`, `2s`, `1m`) |
| `--once` | off | Single replication pass, then exit |

Uses the same env vars as the AWS adapters (`TRACE_DYNAMO_TABLE`, `TRACE_S3_BUCKET`, etc.).

### Docker

Image: `ghcr.io/pascal-lohscheidt/m4trix-tracing-sidecar`

Build from the repository root:

```sh
docker build -f packages/tracing/Dockerfile -t m4trix-tracing-sidecar .
```

Run with a shared traces volume:

```sh
docker run --rm \
  -v /path/to/traces:/traces \
  -e TRACE_DYNAMO_TABLE \
  -e TRACE_S3_BUCKET \
  -e AWS_REGION \
  ghcr.io/pascal-lohscheidt/m4trix-tracing-sidecar:latest
```

Mount the same volume in your application container at `/traces` and point both processes at
that path (`FsStructureStoreAdapter` / `FsPayloadStoreAdapter` with `path: "/traces"`).

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
  patchTraceAnnotation(input: {
    traceId: string;
    annotation: Record<string, unknown>;
    merge?: boolean;
  }): Promise<Trace | null>;
  patchRunAnnotation(input: {
    traceId: string;
    runId: string;
    annotation: Record<string, unknown>;
    merge?: boolean;
  }): Promise<TraceRun | null>;
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
