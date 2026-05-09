---
title: "API Reference"
---

This page summarizes the main public APIs exported from `@m4trix/tracing` and `@m4trix/trace-viewer`.

## Tracer

Use `Tracer.from(...)` to create a callback handler backed by a `TraceStore`.

```ts
const tracer = Tracer.from(traceStore);

await graph.invoke(input, { callbacks: [tracer] });
await tracer.flush();
```

Callback handlers:

- `handleChainStart`, `handleChainEnd`, `handleChainError`
- `handleLLMStart`, `handleLLMEnd`, `handleLLMError`
- `handleChatModelStart`
- `handleToolStart`, `handleToolEnd`, `handleToolError`
- `handleRetrieverStart`, `handleRetrieverEnd`, `handleRetrieverError`

`flush()` waits for in-flight callback writes, writes pending runs in a batch, and upserts pending trace summaries.

## TraceStore

Use `TraceStore.of(...)` to compose structure and payload adapters.

```ts
const traceStore = TraceStore.of({
  structureStoreAdapter,
  payloadStoreAdapter,
});
```

Methods:

- `upsertTrace(trace)`
- `upsertRun(run)`
- `upsertRunBatch(runs)`
- `getTrace(traceId)`
- `listTraces(query?)`
- `putJsonPayload(path, value)`
- `getPayload(ref)`
- `putPayloadStream(path, body)`
- `getPayloadStream(ref)`

Stream methods require a payload adapter that implements `putStream` and `getStream`.

## Filesystem Adapters

Use the built-in adapters for local traces:

```ts
const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: './tmp/traces' }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: './tmp/traces' }),
});
```

`FsStructureStoreAdapter` writes:

- `traces/<traceId>/trace.json`
- `traces/<traceId>/runs.ndjson`

`FsPayloadStoreAdapter` writes JSON and stream payloads inside the configured root and rejects absolute paths or parent-directory refs.

## TraceViewerApi

Use `TraceViewerApi.from(...)` to read traces for a UI or API layer.

```ts
const traceViewerApi = TraceViewerApi.from(traceStore);

const { traces, nextCursor } = await traceViewerApi.listTraces({ limit: 25 });
const tree = await traceViewerApi.getTraceTree(traces[0].traceId);
```

Methods:

- `listTraces(query?)`
- `getTrace(traceId)`
- `getTraceTree(traceId)`
- `getPayload(ref)`

`getTraceTree(...)` returns `{ trace, root }`, where `root` is a `TraceRunNode` with recursive `children`.

## Data Types

```ts
type TraceStatus = 'running' | 'success' | 'error';

type TraceRunType =
  | 'agent'
  | 'chain'
  | 'llm'
  | 'chat_model'
  | 'tool'
  | 'retriever'
  | 'embedding'
  | 'prompt'
  | 'parser'
  | (string & {});
```

`Trace` fields:

- `schemaVersion`
- `traceId`
- `rootRunId`
- `projectId`
- `name`
- `status`
- `startTime`, `endTime`, `latencyMs`
- `tokens`, `costUsd`
- `runCount`
- `metadata`

`TraceRun` fields:

- `schemaVersion`
- `traceId`
- `runId`
- `parentRunId`
- `type`
- `name`
- `status`
- `startTime`, `endTime`, `latencyMs`
- `tokens`, `costUsd`, `error`
- `inputRef`, `outputRef`, `eventsRef`
- `metadata`, `extra`

## Custom Adapters

Implement `StructureStoreAdapter` for trace and run records:

```ts
type StructureStoreAdapter = {
  upsertTrace(trace: Trace): Promise<void>;
  upsertRun(run: TraceRun): Promise<void>;
  upsertRunBatch?(runs: TraceRun[]): Promise<void>;
  getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null>;
  listTraces(query?: ListTracesQuery): Promise<{ traces: Trace[]; nextCursor?: string }>;
};
```

Implement `PayloadStoreAdapter` for JSON payloads and optional streams:

```ts
type PayloadStoreAdapter = {
  putJson(path: string, value: unknown): Promise<string>;
  getJson<T = unknown>(ref: string): Promise<T>;
  putStream?(path: string, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string>;
  getStream?(ref: string): Promise<ReadableStream<Uint8Array>>;
};
```

## Trace Viewer Package

`@m4trix/trace-viewer` exports:

- `createFsTraceViewerApi(traceRootPath)`
- `startTraceViewerServer({ traceViewerApi, port, host? })`
- `appRouter`
- `parseCliArgs(argv)`
- `cliHelpText(program)`
- `DEFAULT_PORT`
- `DEFAULT_FS_RELATIVE_PATH`

