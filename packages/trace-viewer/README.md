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

## Trace profiles and the AI payload mapper

Profiles control how the run detail panel renders payloads. **Raw** and **LangGraph** are built in;
**custom profiles** (✦) are JSON mappings stored in the browser's localStorage. Each custom profile
can be enabled, selected, edited, exported/imported, duplicated and restored from its version
history (Settings → Custom profiles).

A mapping is a list of rules (first match wins) that turn payloads into messages, tool calls, tool
results, key/value lists, markdown, code and tables, plus optional metadata keys and `usage` rules
that feed the trace-wide token/cost aggregates.

**✦ New AI profile** samples input/output payloads from the current trace or the last N traces
(grouped by run type, name and side), lets you review exactly what will be sent (with optional
redaction), and asks a model to write the mapping. The result is validated, dry-run against the
full payloads and repaired automatically before you preview it side by side and save it.
**✦ Improve** re-samples (prioritising unmatched or broken payload groups, or a run you pick via
"Improve with this run"), checks stored samples for regressions, and saves the result as a new
version with a rule diff and before/after coverage.

Bring your own key — requests go directly from the browser to the provider; the trace-viewer
server never sees the key. Keys stay in memory unless "Remember keys on this device" is enabled.

| Provider | Endpoint | Auth |
| --- | --- | --- |
| Claude API | `api.anthropic.com` (Messages API via `@anthropic-ai/sdk`) | Anthropic API key |
| OpenAI | `api.openai.com/v1/responses` (JSON mode) | OpenAI API key |
| Amazon Bedrock | `bedrock-runtime.<region>.amazonaws.com` (Converse API, any text model) | Bedrock API key or access keys (SigV4) |
| Amazon Bedrock Mantle | `bedrock-mantle.<region>.api.aws` (Claude Messages API, `anthropic.*` model ids) | Bedrock API key or access keys (SigV4) |

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
