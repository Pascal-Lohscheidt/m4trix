---
title: "CLI and Viewer"
---

`@m4trix/trace-viewer` ships a local browser UI for traces written by `@m4trix/tracing`.

## Start the Viewer

Filesystem (local development):

```bash
m4trix-trace-viewer --adapter fs --path ./tmp/traces --port 4319
```

AWS stack (DynamoDB structure + S3 payloads):

```bash
export TRACE_DYNAMO_TABLE=my-traces
export TRACE_S3_BUCKET=my-trace-payloads
export AWS_REGION=us-east-1

m4trix-trace-viewer --adapter aws-stack --port 4319
```

Options:

- `--adapter fs|aws-stack` selects the storage backend. `fs` is the default.
- `--path <dir>` sets the filesystem trace root (required for `fs`). The default is `tmp/tracing-example`.
- `--port <n>` sets the HTTP port. The default is `4319`.
- `-h, --help` prints the CLI help text.

For `aws-stack`, configure storage via environment variables instead of `--path`:

| Variable | Purpose |
|----------|---------|
| `TRACE_DYNAMO_TABLE` | DynamoDB table name (required) |
| `TRACE_S3_BUCKET` | S3 bucket for payloads (required) |
| `TRACE_S3_PREFIX` | Optional S3 key prefix |
| `AWS_REGION` | AWS region |
| `AWS_ENDPOINT_URL` | Optional (LocalStack) |

If the binary is not on your shell path, run it through your package manager:

```bash
pnpm exec m4trix-trace-viewer --adapter fs --path ./tmp/traces --port 4319
```

## Filesystem Layout

The filesystem adapters store traces under the configured root:

```txt
tmp/traces/
  traces/
    <traceId>/
      trace.json
      runs.ndjson
      payloads/
        <runId>/
          input.json
          output.json
```

`trace.json` contains the trace summary. `runs.ndjson` contains one JSON run per line. Payload files are referenced by `inputRef` and `outputRef`.

## Viewer API

The viewer serves a tRPC API under `/trpc`:

- `traces.list` lists trace summaries with optional filters.
- `traces.getTree` returns one trace with its nested run tree.
- `traces.getPayload` reads a JSON payload by ref.
- `traces.patchAnnotation` deep-merges a trace-level `annotation` object.
- `traces.patchRunAnnotation` deep-merges a run-level `annotation` object.

The browser app uses these procedures to keep the trace list fast and load large payloads only when needed.

## Programmatic Server

Filesystem:

```ts
import { createFsTraceViewerApi, startTraceViewerServer } from '@m4trix/trace-viewer';

const traceViewerApi = createFsTraceViewerApi('./tmp/traces');
const server = startTraceViewerServer({
  traceViewerApi,
  port: 4319,
});

process.on('SIGINT', () => server.close());
```

AWS stack:

```ts
import { createAwsStackTraceViewerApi, startTraceViewerServer } from '@m4trix/trace-viewer';

const traceViewerApi = createAwsStackTraceViewerApi({
  dynamoTable: process.env.TRACE_DYNAMO_TABLE,
  s3Bucket: process.env.TRACE_S3_BUCKET,
});
startTraceViewerServer({ traceViewerApi, port: 4319 });
```

`startTraceViewerServer` listens on `127.0.0.1` by default. Pass `host` when you need to bind another interface.

## Querying Traces

The API accepts the same query shape as `TraceStore.listTraces(...)`:

```ts
await traceViewerApi.listTraces({
  projectId: 'support-agent',
  status: 'error',
  limit: 50,
});
```

Supported filters:

- `projectId`
- `status`
- `startAfter`
- `startBefore`
- `limit`
- `cursor`

The filesystem adapter sorts traces newest first and returns `nextCursor` when more results are available.

## Annotations

Traces and runs expose an optional `annotation` field (JSON object) for post-hoc review notes.
Use the tRPC mutations or library API:

```ts
await traceViewerApi.patchTraceAnnotation({
  traceId: 'trace-1',
  annotation: { review: { status: 'approved' } },
});
```

Pass `merge: false` to replace the entire annotation. Pass `{}` with `merge: false` to clear it.
