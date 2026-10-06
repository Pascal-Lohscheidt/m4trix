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
- **`--no-mcp`** — do not serve the MCP endpoint at `/mcp` (see below).

Then open **http://127.0.0.1:4319** in a browser.

## MCP server for coding agents

The running viewer also serves an [MCP](https://modelcontextprotocol.io) endpoint at
**http://127.0.0.1:4319/mcp** (Streamable HTTP). Coding agents connect to it over localhost to
inspect, search and compare the same traces you see in the UI. Agents need no trace path or
credentials, and payloads loaded by one call stay searchable for later calls.

```bash
# Claude Code
claude mcp add --transport http m4trix-traces http://127.0.0.1:4319/mcp
```

Other clients take the same URL, e.g. `.mcp.json` / Cursor:
`{ "mcpServers": { "m4trix-traces": { "type": "http", "url": "http://127.0.0.1:4319/mcp" } } }`.
Clients without HTTP support can bridge with `npx -y mcp-remote http://127.0.0.1:4319/mcp`.

The endpoint only accepts requests whose `Host` (and `Origin`, if sent) is loopback, so web pages
cannot reach it through your browser. Disable it with `--no-mcp`. To run the MCP without the
viewer, `m4trix-trace-viewer mcp --path <dir>` serves it over stdio instead.

| Tool | Purpose |
| --- | --- |
| `list_traces` | Newest-first traces filtered by status, project, name, metadata, time range, latency |
| `get_trace` | Run tree outline (LangGraph plumbing hidden by default, errors never hidden) |
| `find_runs` | Runs by type, name, status, error text, latency, tokens, metadata across traces |
| `get_run` | One run: ancestry, timing, full error, children, payload previews |
| `get_payload` | Payload as outline or JSON, narrowed by JSONPath, paged with `offset` |
| `load_trace_payloads` | Load trace payloads into the in-memory search index |
| `search_payloads` | Text/regex search; identical values grouped at the run where they first appeared |
| `analyze_trace` | Root-cause errors, unfinished/orphan runs, critical path, token hotspots, loops, swallowed errors |
| `get_conversation` | Chat transcript (OpenAI, Anthropic, LangChain shapes) of a run |
| `compare` | Diff two runs' payloads, or align two traces run by run |
| `annotate` | Write a trace/run annotation (the tool tells agents to ask the user first) |

Trace ids accept `latest` or a unique prefix; run ids accept a unique prefix. Payload strings that
contain JSON are decoded, so paths and search reach into serialized tool arguments.

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

`startTraceViewerServer` serves the MCP at `/mcp` unless `mcp: false` is passed.
`createTraceMcpHttpHandler({ traceViewerApi })` returns a Node request handler to mount it elsewhere,
and `createTraceMcpServer({ traceViewerApi })` returns an `McpServer` for any MCP transport
(`startTraceMcpStdioServer` does that for stdio).

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
