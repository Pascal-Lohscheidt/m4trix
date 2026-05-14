---
title: "Concepts"
---

Tracing stores a tree of callback runs. A top-level run becomes a trace, and child callbacks become nested runs under the same `traceId`.

## Traces and Runs

A `Trace` is the summary record shown in trace lists:

- `traceId` and `rootRunId`
- `name`, `status`, `startTime`, optional `endTime`, and `latencyMs`
- optional `projectId`, `metadata`, token totals, and cost
- `runCount`

A `TraceRun` is one node in the trace tree:

- `runId`, `traceId`, and optional `parentRunId`
- `type`, `name`, `status`, and timing fields
- optional `inputRef`, `outputRef`, `eventsRef`, `tokens`, `error`, `metadata`, and `extra`

The tracer derives the `traceId` from the root run. Child runs keep their own `runId` and point back to their parent with `parentRunId`.

## Run Types

Built-in run types include:

- `agent`
- `chain`
- `llm`
- `chat_model`
- `tool`
- `retriever`
- `embedding`
- `prompt`
- `parser`

The type is inferred from callback handlers where possible. Chain callbacks can also pass a supported run type as the callback `runTypeOrName`; otherwise they are stored as `chain` runs.

## Payload References

Trace structure stays small. Inputs and outputs are written through the payload adapter, and runs store references to those payloads:

```ts
{
  runId: 'tool-run-1',
  inputRef: 'traces/trace-1/payloads/tool-run-1/input.json',
  outputRef: 'traces/trace-1/payloads/tool-run-1/output.json',
}
```

The viewer uses those references to lazy-load payloads only when a run is selected.

## Metadata and Project IDs

Callback metadata is copied onto trace records when values are strings, numbers, or booleans. `projectId` is treated specially: it becomes the trace-level `projectId` and is excluded from the generic metadata object.

```ts
import { toLangGraph } from '@m4trix/tracing';

const lgTracer = tracer.adapt(toLangGraph);

await graph.invoke(input, {
  callbacks: [lgTracer],
  metadata: {
    projectId: 'checkout-agent',
    env: 'staging',
    tenant: 'acme',
  },
});
```

Use `projectId` when you want viewer or API queries to filter traces by application, workflow, tenant, or experiment family.

## Status and Errors

Runs start as `running` and finish as `success` or `error`. Error runs store the error message and error type:

```ts
{
  status: 'error',
  error: {
    message: 'Model request failed',
    type: 'TimeoutError',
  },
}
```

A trace is marked `error` when any run in its tree has errored.

## Flushing

Callback handlers write asynchronously. `Tracer.flush()` waits for pending callback work, batches pending run updates, and upserts pending trace summaries.

Call `flush()` when:

- a script is about to exit
- a test expects traces to be available immediately
- you are about to open the trace viewer after a short local run

Long-running servers can flush at request boundaries, job boundaries, or shutdown hooks.

## Storage Adapters

`TraceStore` separates structure from payloads:

```ts
TraceStore.of({
  structureStoreAdapter,
  payloadStoreAdapter,
});
```

The structure adapter stores `Trace` and `TraceRun` records and handles list/query operations. The payload adapter stores JSON payloads and optional streams.

The package includes filesystem adapters for local development. Implement `StructureStoreAdapter` and `PayloadStoreAdapter` when you want to store traces in a database, object store, or hosted observability backend.

