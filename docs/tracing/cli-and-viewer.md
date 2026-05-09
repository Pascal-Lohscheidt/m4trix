---
title: "CLI and Viewer"
---

`@m4trix/trace-viewer` ships a local browser UI for traces written by `@m4trix/tracing`.

## Start the Viewer

```bash
m4trix-trace-viewer --adapter fs --path ./tmp/traces --port 4319
```

Options:

- `--adapter fs|aws-stack` selects the storage backend. `fs` is the default; `aws-stack` currently exits with a clear not-implemented message.
- `--path <dir>` sets the filesystem trace root. The default is `tmp/tracing-example`.
- `--port <n>` sets the HTTP port. The default is `4319`.
- `-h, --help` prints the CLI help text.

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

The browser app uses these procedures to keep the trace list fast and load large payloads only when needed.

## Programmatic Server

You can embed the viewer server in your own local tooling:

```ts
import { createFsTraceViewerApi, startTraceViewerServer } from '@m4trix/trace-viewer';

const traceViewerApi = createFsTraceViewerApi('./tmp/traces');
const server = startTraceViewerServer({
  traceViewerApi,
  port: 4319,
});

process.on('SIGINT', () => server.close());
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

