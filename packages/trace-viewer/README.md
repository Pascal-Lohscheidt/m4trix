# @m4trix/trace-viewer

Filesystem-backed **trace viewer** for [`@m4trix/tracing`](https://github.com/Pascal-Lohscheidt/m4trix): a small HTTP server with a **tRPC** API (`/trpc`) and a **Vite + React + Tailwind** UI.

## CLI

From the **repo root** (after `pnpm install`, which links this package’s bin):

```bash
pnpm exec m4trix-trace-viewer --adapter fs --path ./tmp/tracing-example --port 4319
```

If `pnpm exec` still can’t find the command, run it via the workspace filter:

```bash
pnpm --filter @m4trix/trace-viewer exec m4trix-trace-viewer --adapter fs --path ./tmp/tracing-example --port 4319
```

- **`--adapter fs`** — read traces via `FsStructureStoreAdapter` / `FsPayloadStoreAdapter` at `--path`.
- **`--adapter aws-stack`** — DynamoDB structure + S3 payloads via `TRACE_DYNAMO_TABLE`, `TRACE_S3_BUCKET`, and `AWS_REGION`.
- **`--port`** — HTTP listen port (default `4319`).
- **`--path`** — trace root for `fs` (default `tmp/tracing-example`).

Then open **http://127.0.0.1:4319** in a browser.

## Programmatic usage

```ts
import { createFsTraceViewerApi, startTraceViewerServer } from '@m4trix/trace-viewer';

const traceViewerApi = createFsTraceViewerApi('./tmp/tracing-example');
startTraceViewerServer({ traceViewerApi, port: 4319 });
```

## tRPC procedures

- `traces.list` — `TraceViewerApi.listTraces`
- `traces.getTree` — `TraceViewerApi.getTraceTree`
- `traces.getPayload` — `TraceViewerApi.getPayload` (lazy load in the UI)

## Develop

The package build is intentionally split but still portable:

- `tsup` builds the publishable Node library and CLI into `dist/`.
- `vite build` builds the browser app from `src/app/index.html` into `dist/client/`.
- `pnpm run build` is just `tsup && vite build`, using package-local binaries resolved by the package manager.

```bash
pnpm --filter @m4trix/trace-viewer build
pnpm --filter @m4trix/trace-viewer test
```
