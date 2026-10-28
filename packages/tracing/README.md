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

The root entry has no runtime dependencies. The DynamoDB / S3 adapters live in the
`@m4trix/tracing/aws` entry and need the AWS SDK, which is an optional peer dependency:

```sh
pnpm add @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-s3
```

The sidecar CLI (`m4trix-tracing-sidecar`) bundles the AWS SDK and needs no extra install.

## Upgrading to 0.12

0.12 makes the tracer safe to run in production and records much more per run. No storage
migration is needed; older readers ignore the new fields.

- **The tracer never throws into your app.** `flush()` and every callback resolve even when the
  store is down. Failures go to the new `onError` option (default: `console.warn`) and to
  `tracer.stats()`. If you relied on `flush()` rejecting, use `onError` instead.
- **Traces flush on their own** once their last run ends, and failed flushes are retried with
  backoff. Pass `autoFlush: false` to keep the old explicit-only behaviour. Keep calling
  `await tracer.flush()` before a short-lived process exits.
- **Memory is bounded.** When the store cannot keep up, buffered traces are dropped (and reported)
  beyond `maxBufferedRuns` (default 10 000), finished ones waiting to be written first.
- **Payloads are capped** at `maxPayloadBytes` (default 4 MiB); larger ones are stored as a
  truncated preview. Payloads with cycles, BigInts, or Errors no longer fail to store.
- **Run tags are first-class** (`run.tags`, `trace.tags`) instead of `run.extra.tags`.
- **Errors carry more detail**: `stack`, HTTP `status`, `code`, and `cause`.
- **`toM4trixTracer` records a network run's context id as `sessionId`**, not `projectId`. Pass
  `toM4trixTracer(tracer, { projectId })` to set a project.
- **Sessions:** `sessionId` / `userId` in root metadata (and LangGraph's `thread_id`) are lifted
  onto the trace, like `projectId`.
- **Core:** `@m4trix/core` now guards every `NetworkTracer` hook (a failing tracer no longer fails
  the network) and starts a network run's trace under the run id of its start event.
- **Versions:** `toM4trixTracer` needs `@m4trix/core` 0.18 (the optional peer range is now
  `^0.18.0`; 0.11 declared `^0.7.0`, which npm rejects next to newer cores). Upgrade
  `@m4trix/trace-viewer` to 0.20 together with this release; it requires `@m4trix/tracing` 0.12 to
  show cancelled runs.

## Upgrading to 0.11

0.11 changes import paths and the DynamoDB item layout. Read this before upgrading anything that
writes to or reads from a shared trace table.

- **AWS adapters moved.** Import `DynamoStructureStoreAdapter`, `S3PayloadStoreAdapter` and the
  `resolve*OptionsFromEnv` helpers from `@m4trix/tracing/aws`. The AWS SDK is now an optional peer
  dependency: install `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` and `@aws-sdk/client-s3`
  yourself if you use that entry.
- **Upgrade every writer and reader of a table together.** That means sidecars, trace viewers
  (`@m4trix/trace-viewer` 0.18 or later) and apps writing with the DynamoDB adapter directly.
  Annotations now live in their own attribute. Older versions replace whole items on write, which
  wipes annotations stored by 0.11, and they don't show annotations made with 0.11.
- **IAM.** DynamoDB writes now use `dynamodb:UpdateItem` instead of `dynamodb:PutItem`.
- **List shards (opt-in).** Enable `listShards` / `TRACE_DYNAMO_LIST_SHARDS` only once every reader
  runs 0.11, use the same value everywhere, and never lower it afterwards: traces in dropped shards
  stop appearing in lists.
- **Sidecar.**
  - It now deletes fully shipped traces from local disk after 5 minutes. Pass `--keep-shipped` to
    keep them.
  - The CLI file is now `dist/trace-shipper-cli.mjs`; the `m4trix-tracing-sidecar` command is
    unchanged.
  - The image runs as uid 1000, so it needs write access to the shared volume.
- **Rolling a sidecar back to 0.10 or earlier.** Traces in the middle of shipping can get stuck,
  because older sidecars expect a payload list in `.shipper/state.json` that 0.11 no longer writes.
  Drain first: stop the app, run the 0.11 sidecar once with `--once`, then roll back.

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
  status: "running" | "success" | "error" | "cancelled";
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  timeToFirstTokenMs?: number;
  model?: string; // the model that served the call
  provider?: string;
  tokens?: TraceTokens;
  costUsd?: number;
  error?: TraceError; // { message, type?, stack?, status?, code?, cause?: TraceError }
  tags?: string[];
  inputRef?: string;
  outputRef?: string;
  eventsRef?: string; // JSON array of { name, time, data } events
  metadata?: Record<string, string | number | boolean>;
  annotation?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

// `cached` (cache reads) and `cacheCreation` (cache writes) are part of `input`;
// `reasoning` is part of `output` — as in the OpenTelemetry GenAI conventions.
export type TraceTokens = {
  input: number;
  output: number;
  cached?: number;
  cacheCreation?: number;
  reasoning?: number;
};

export type Trace = {
  schemaVersion: 1;
  traceId: string;
  rootRunId: string;
  projectId?: string;
  sessionId?: string; // one conversation / thread
  userId?: string;
  name: string;
  status: "running" | "success" | "error" | "cancelled";
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  tokens?: TraceTokens; // summed over all runs
  costUsd?: number; // summed over all runs
  runCount: number;
  tags?: string[];
  remoteParent?: { traceId: string; spanId: string; sampled: boolean }; // from traceparent
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

### What gets recorded

For every LangChain / LangGraph run the tracer records inputs and outputs (as payloads), timing,
status, tags and scalar metadata, and additionally:

- **Model calls:** the requested model and provider (from `invocation_params` and LangChain's
  `ls_provider` metadata), then the model that actually served the call; token usage from
  `usage_metadata` (cache reads/writes and reasoning tokens included) or the legacy `llmOutput`
  fields; time to first token for streamed calls.
- **Events:** `dispatchCustomEvent` events, agent actions, and text callbacks, stored per run.
- **Errors:** message, type, stack, HTTP status, code, and the `cause` chain.
- **Trace attributes:** `projectId`, `sessionId`, `userId`, and `traceparent` from the root run's
  metadata are lifted onto the trace. LangGraph's `configurable.thread_id` becomes the `sessionId`,
  so every turn of a conversation can be listed with `listTraces({ sessionId })`.

### Options

```ts
import { priceTable, ratioSampler, Tracer } from "@m4trix/tracing";

const tracer = Tracer.from(traceStore, {
  onError: (failure) => logger.warn(failure.message, failure), // default: throttled console.warn
  sampler: ratioSampler(0.1), // keep 10% of traces
  redact: (payload, { kind, runType }) => scrubEmails(payload),
  maxPayloadBytes: 1024 * 1024, // default 4 MiB
  maxBufferedRuns: 10_000, // default
  maxEventsPerRun: 1_000, // default
  cost: priceTable({
    "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 }, // USD per 1M tokens
    "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  }),
  autoFlush: true, // default
});
```

- **Never throws.** Callbacks and `flush()` always resolve. Storage, redaction, sampler, and cost
  failures go to `onError` with a `kind` (`payload`, `redact`, `flush`, `dropped`, `hook`) and are
  counted in `tracer.stats()`. The default handler warns at most once a minute per kind.
- **Outages.** A failed flush keeps its records and is retried after 1 s, doubling up to 30 s;
  traces finishing meanwhile join that retry instead of each hitting the store.
- **Bounded memory.** Runs are buffered until written. If more than `maxBufferedRuns` are buffered
  (the store is down or too slow), traces are dropped and reported as `dropped`: the oldest
  finished ones waiting to be written first, running ones only when that is not enough. Size the
  limit above your peak of concurrently running runs.
- **Redaction** runs on every input, output, and event payload before it is stored. If the
  redactor throws, the payload is dropped, never stored unredacted. Metadata is not redacted: keep
  it free of sensitive values.
- **Sampling** is decided once per trace, at its root run; a sampled-out trace costs no writes.
  `ratioSampler` hashes the OpenTelemetry trace id, so services sharing a trace through
  `traceparent` agree. `parentBasedSampler(root)` follows an upstream caller's decision, and
  sampled-out runs still hand out a `traceparent` (flagged unsampled) so downstream services can.
- **Cost** is computed per run from the served model and tokens, and summed per trace. The library
  ships no prices; `priceTable` matches a model by exact id or the longest prefix
  (`gpt-4o` covers `gpt-4o-2024-08-06`).

`tracer.stats()` returns `{ activeTraces, bufferedRuns, pendingRuns, droppedTraces, droppedRuns,
droppedEvents, sampledOutTraces, failedFlushes, failedPayloads }`, which is useful as metrics.

### Tracing your own code

`startRun` traces anything, not only LangChain. A run without a parent starts a new trace:

```ts
const request = tracer.startRun({
  type: "chain",
  name: "POST /chat",
  input: body,
  sessionId: body.conversationId,
  userId: user.id,
  traceparent: req.headers.traceparent, // continue the caller's trace
});
const call = tracer.startRun({ type: "tool", name: "crm.lookup", parentRunId: request.runId });
await fetch(url, { headers: { traceparent: call.traceparent() ?? "" } }); // propagate downstream
call.addEvent("cache_miss", { key });
await call.end({ output: customer });

// Nest a LangGraph call under the request span:
await graph.invoke(input, { callbacks: [tracer.childOf(request.runId)] });

await request.end({ output: reply }); // or request.end({ error })
```

### m4trix agent networks

```ts
import { toM4trixTracer } from "@m4trix/tracing";

const network = AgentNetwork.setup(setup, {
  networkTracer: toM4trixTracer(tracer, { name: "support-bot", projectId: "support" }),
});
```

Each network run becomes a trace whose `sessionId` is the run's context id. Agent invocations
nest under it (with the triggering event as input), spans started through the agent's `tracing`
scope nest under the agent (LLM spans read usage and model from their output message), and
published events are recorded on the run (`captureEvents: false` turns that off). Inside an agent,
`tracer.childOf(tracing.runId)` nests LangChain calls under the agent span. A run cancelled by the
client (and the agent invocations it aborted) ends with status `cancelled`, not `error`; call
`tracer.endRun(runId, { cancelled: true })` to do the same for your own runs.

## Reading Traces

```ts
await traceViewerApi.listTraces({ projectId: "my-app", limit: 25 });
await traceViewerApi.getTrace(traceId);      // { trace, runs } | null
await traceViewerApi.getTraceTree(traceId);  // { trace, root: TraceRunNode } | null
await traceViewerApi.getPayload(ref);        // resolves any JSON payload ref
await traceViewerApi.listTraces({
  sessionId: "thread-1", // also: userId, tags (all must match), minLatencyMs, minCostUsd
});
await traceViewerApi.getTraceExample(traceId); // root input/output, tags, metadata, scores

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

Annotations are owned by the patch APIs. `upsertTrace` / `upsertRun` / `upsertRunBatch` calls that
omit `annotation` keep the stored one, so the tracer flushing a still-running trace (or the sidecar
re-shipping it) never wipes a review. Passing `annotation` to an upsert explicitly replaces it.

Concurrent edits do not overwrite each other: the filesystem adapter serializes writes per trace
within a process, and the DynamoDB adapter uses version-checked conditional updates with retries.

## Scores

Scores are named judgements of a trace or one of its runs: a number, a pass/fail, or a label.

```ts
await traceViewerApi.score({
  traceId,
  name: "helpfulness",
  value: 0.8, // number | boolean | string
  source: "llm_judge", // "human" | "llm_judge" | "eval" | "heuristic" | any string
  comment: "Answered, but verbose",
});
await traceViewerApi.score({ traceId, runId, name: "relevant", value: false, source: "human" });

readScores(trace.annotation); // { helpfulness: { value, source, comment, createdAt } }
```

Scores live in the annotation under `scores.<name>`, written as atomic patches: scores with
different names never overwrite each other, and scoring the same name again replaces it. That
needs no adapter support, so it works with every structure store.

Together with `getTraceExample`, this closes the loop with evaluations: turn production traces
into test cases (e.g. with `@m4trix/evals`' `TestCase.describe({ input: example.input, ... })`)
and write eval results back to the traces they came from.

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
          events.json
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
import { TraceStore } from "@m4trix/tracing";
import {
  DynamoStructureStoreAdapter,
  S3PayloadStoreAdapter,
  resolveDynamoStructureStoreOptionsFromEnv,
  resolveS3PayloadStoreOptionsFromEnv,
} from "@m4trix/tracing/aws";

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
| `TRACE_S3_FORCE_PATH_STYLE` | Optional `true` / `false`; defaults to `true` when a custom endpoint is set |
| `TRACE_DYNAMO_LIST_SHARDS` | Optional; spread trace list writes over N partitions (default `1`) |
| `TRACE_DYNAMO_PROJECT_INDEX` | Optional; name of the per-project GSI (see below) |
| `TRACE_DYNAMO_TTL_SECONDS` | Optional; expire items this long after their trace / run started |
| `TRACE_DYNAMO_TTL_ATTRIBUTE` | Optional; TTL attribute name (default `expiresAt`) |

DynamoDB table schema (single-table):

| Attribute | Key | Notes |
|-----------|-----|-------|
| `pk` | partition | `traceId` |
| `sk` | sort | `TRACE` or `RUN#<runId>` |
| `listPk` | GSI `byStartTime` PK | `PROJECT#_all`, or `PROJECT#_all#<n>` with list shards |
| `listSk` | GSI `byStartTime` SK (and optional project GSI SK) | trace `startTime` (ISO) |
| `projectPk` | optional project GSI PK | `PROJECT#<projectId>` on trace items with a project |
| `trace` / `run` | — | trace / run documents, without `annotation` |
| `annotation` | — | review annotation, written only by the patch APIs |
| `annotationVersion` | — | optimistic-concurrency counter for annotation patches |

Listing reads the `byStartTime` index newest first and narrows `startAfter` / `startBefore` with a
key condition on `listSk`. Two opt-in settings help at higher volume:

- **List shards** (`listShards` / `TRACE_DYNAMO_LIST_SHARDS`): every trace write lands on the
  single `PROJECT#_all` key by default, which becomes a hot partition at high trace rates. With N
  shards, writes spread over `PROJECT#_all#0..N-1`, and listing queries each shard (plus the
  unsharded key, so older traces stay listed) and merges them. Writers (app or sidecar) and readers
  (viewer) must use the same value.
- **Project index** (`projectIndexName` / `TRACE_DYNAMO_PROJECT_INDEX`): without it, a `projectId`
  query filters the global list. Add a GSI with partition key `projectPk` and sort key `listSk`
  and set its name to query one project directly. `projectPk` is written on every trace upsert, so
  traces written before upgrading only appear in it once they are written again.

**Retention:** with `ttlSeconds` / `TRACE_DYNAMO_TTL_SECONDS`, every item gets an epoch-seconds
`expiresAt` attribute counted from its start time (re-shipping never extends it). Enable DynamoDB
TTL on that attribute, and add a matching S3 lifecycle rule for the payload prefix.

`sessionId`, `userId`, `tags`, `minLatencyMs`, and `minCostUsd` list queries are filters on the
start-time index, so they read through the time range: narrow with `startAfter` / `startBefore`.

Required IAM actions on the table and its indexes: `dynamodb:UpdateItem` (all writes, including
ingest), `dynamodb:GetItem` and `dynamodb:Query` (reads and annotation patches).

`getTrace` follows query pagination, so traces larger than one 1 MB query page come back complete.
Items written by 0.8.0 kept `annotation` inside `trace` / `run`; they are still read, and the next
patch moves the annotation to the top-level attribute.

Payload refs remain logical paths like `traces/{traceId}/payloads/{runId}/input.json`.

## OpenTelemetry

`@m4trix/tracing/otel` exports traces to any OTLP/HTTP backend (an OpenTelemetry Collector, Jaeger,
Honeycomb, Datadog, Grafana Tempo...) following the GenAI semantic conventions: `chat {model}`,
`execute_tool {name}`, `invoke_agent {name}` spans with `gen_ai.usage.*` tokens (including cache and
reasoning), `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.conversation.id` (the session),
time to first chunk, error status, and scores as `gen_ai.evaluation.result` events. It needs no
OpenTelemetry SDK. Payload contents (prompts and outputs) are not exported.

```ts
import { OtlpHttpExporter, withOtlpExport } from "@m4trix/tracing/otel";

const structureStoreAdapter = withOtlpExport(
  new FsStructureStoreAdapter({ path: "./.traces" }),
  new OtlpHttpExporter({ url: "http://localhost:4318/v1/traces", serviceName: "support-api" }),
);
const traceStore = TraceStore.of({
  structureStoreAdapter,
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: "./.traces" }),
});

// On shutdown:
await tracer.flush();
await structureStoreAdapter.drainExports();
```

`withOtlpExport` wraps any structure store and exports each trace once it is written finished,
with no run still running. Exports run in the background (4 at a time, up to 1 000 queued), so a
slow or unreachable backend never slows down tracing; await `drainExports()` before the process
exits. Failures go to its `onError` and never fail the write; a trace whose export failed
or was skipped is exported if it is written again. `toOtlpTraceRequest(records, { serviceName })`
gives the raw OTLP/JSON for custom transports.

Traces that continue a `traceparent` join the caller's OpenTelemetry trace, and
`tracer.traceparent(runId)` / `run.traceparent()` propagates the trace to services you call.

## Trace Sidecar (filesystem → AWS)

For production deployments, write traces locally with the filesystem adapters and run
`m4trix-tracing-sidecar` in a companion container to replicate payloads to S3 and structure to
DynamoDB. The app avoids network latency and AWS credentials; the sidecar handles upload,
ordering, and cleanup.

```txt
App (FsStructure + FsPayload)  →  shared volume (/traces)
Sidecar (m4trix-tracing-sidecar)  →  S3 + DynamoDB
```

Replication order: **payloads first**, then **structure** (`trace.json`, `runs.ndjson`) once none
of the referenced payloads is still waiting on local disk. Local payload files are deleted after a
successful S3 put, so a payload is pending exactly while its file exists. Structure progress (last
shipped mtime per file) is tracked in `{root}/.shipper/state.json` (sidecar-owned, written
atomically); an unreadable state file just causes a safe re-ship.

Failure handling:

- A failing item (S3/DynamoDB error, malformed file) is logged and retried on the next pass; it
  never blocks other traces, and an interrupted pass never strands a trace.
- Annotations are not shipped. They belong to the hosted store, so review edits made there survive
  re-shipping.
- Fully shipped traces are deleted from local disk once idle for `--retain` (default `5m`), so the
  shared volume does not fill up. Traces still marked running (e.g. the app crashed mid-trace) wait
  for `--retain-running` (default `24h`). Folders mid-write, with payloads left, or with files the
  sidecar does not know are kept. Use `--keep-shipped` to keep everything.
- On `SIGTERM` / `SIGINT` the sidecar stops polling, makes one final pass, then exits. Make sure it
  outlives the app container (for example a Kubernetes native sidecar: an init container with
  `restartPolicy: Always`) so traces flushed during app shutdown are still shipped.

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
| `--once` | off | Single replication pass, then exit (non-zero exit if any item failed) |
| `--retain <dur>` | `5m` | Delete finished, fully shipped traces locally once idle this long (`0` = right away) |
| `--retain-running <dur>` | `24h` | Same for traces never marked finished |
| `--keep-shipped` | off | Never delete shipped traces from local disk |

Uses the same env vars as the AWS adapters (`TRACE_DYNAMO_TABLE`, `TRACE_S3_BUCKET`, etc.). Set
`OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, plus optional
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME`) to also export every shipped, finished trace
over OTLP, with no change to the app.

### Docker

Image: `ghcr.io/pascal-lohscheidt/m4trix-tracing-sidecar`, for `linux/amd64` and `linux/arm64`.
Every `@m4trix/tracing` release publishes a tag with its version (e.g. `:0.12.0`); `:latest` is
the newest release. Pin the version that matches the `@m4trix/tracing` your app uses. Each image is
scanned for vulnerabilities before it is published. `/app/trace-shipper-cli.cdx.json` (also in the
npm package's `dist/`) is a CycloneDX SBOM of the npm packages bundled into the CLI, so your own
scanners see them too.

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

The image runs Node 24 as the non-root `node` user (uid 1000) and contains only the bundled CLI (no npm, npx, corepack or yarn).
The sidecar deletes shipped files, so it needs write access to what the app writes: run both
containers with the same user / group, or set a shared `fsGroup` in Kubernetes.

## Adapter Interfaces

```ts
export type StructureStoreAdapter = {
  upsertTrace(trace: Trace): Promise<void>;
  upsertRun(run: TraceRun): Promise<void>;
  upsertRunBatch?(runs: TraceRun[]): Promise<void>;
  getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null>;
  listTraces(query?: {
    projectId?: string;
    sessionId?: string;
    userId?: string;
    status?: Trace["status"];
    tags?: string[];
    minLatencyMs?: number;
    minCostUsd?: number;
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

- Rate limiting (sampling is supported).
- Redacting metadata and error messages (payload redaction is supported).
- Multi-tenant auth and authorization in the viewer.
- Retention for the filesystem adapters outside the sidecar.
- Production-scale querying in the filesystem structure adapter.
