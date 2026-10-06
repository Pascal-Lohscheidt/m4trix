import type { TraceViewerApi } from '@m4trix/tracing';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { truncate } from './json-utils';
import type { PayloadIndexOptions } from './payload-index';
import { TraceToolError } from './trace-access';
import { TraceTools } from './trace-tools';
import { DEFAULT_HIDE_PATTERN } from './tree-outline';

/** Hard cap per tool response, independent of per-tool limits. */
const MAX_RESPONSE_CHARS = 60_000;

const SERVER_INSTRUCTIONS = `
Debug LLM / LangGraph traces recorded by @m4trix/tracing.

Workflow:
1. list_traces (or pass traceId "latest" anywhere) to pick a trace.
2. get_trace for the run tree, analyze_trace for errors, slow spans, token hotspots, loops and swallowed errors.
3. get_run / get_conversation / get_payload to drill into one run. Use get_payload mode "outline" first for big payloads, then fetch a precise JSONPath.
4. To search payload contents, call load_trace_payloads (or pass traceIds to search_payloads), then search_payloads.
   Identical values are grouped and attributed to the run where they first appeared — use this to find where a bad value originated.
5. compare two runs (payload diff) or two traces (structure diff) to find regressions.

Trace and run ids may be given as unique prefixes (the 8-char ids shown in outputs work).
Payload strings that contain JSON are decoded, so JSONPaths can reach into them.
`.trim();

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const traceIdField = z.string().min(1).describe('Trace id, unique prefix, or "latest".');
const runIdField = z.string().min(1).describe('Run id or unique prefix within the trace.');
const sideField = z.enum(['input', 'output']);
const statusField = z.enum(['running', 'success', 'error']);

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

async function respond(task: () => Promise<string>): Promise<CallToolResult> {
  try {
    const text = await task();
    return { content: [{ type: 'text', text: truncate(text, MAX_RESPONSE_CHARS) }] };
  } catch (error) {
    const message =
      error instanceof TraceToolError
        ? error.message
        : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

export type TraceMcpServerOptions = {
  traceViewerApi: TraceViewerApi;
  index?: PayloadIndexOptions;
  version?: string;
  /** Shared tool state (payload index). Pass one instance to keep loaded payloads across servers. */
  tools?: TraceTools;
};

export function createTraceMcpServer(options: TraceMcpServerOptions): McpServer {
  const tools = options.tools ?? new TraceTools(options.traceViewerApi, { index: options.index });
  const server = new McpServer(
    { name: 'm4trix-traces', version: options.version ?? '0.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'list_traces',
    {
      title: 'List traces',
      description:
        'List recorded traces, newest first, with status, latency, run count, tokens and metadata. Filters combine with AND.',
      inputSchema: {
        status: statusField.optional(),
        projectId: z.string().optional(),
        name: z.string().optional().describe('Case-insensitive regex against the trace name.'),
        metadata: z
          .record(scalar)
          .optional()
          .describe('Exact match on trace metadata, e.g. { "env": "dev" }.'),
        since: z.string().optional().describe('ISO timestamp; only traces started after it.'),
        until: z.string().optional().describe('ISO timestamp; only traces started before it.'),
        minLatencyMs: z.number().nonnegative().optional(),
        annotated: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional().describe('Default 20.'),
        offset: z.number().int().nonnegative().optional(),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.listTraces(input)),
  );

  server.registerTool(
    'get_trace',
    {
      title: 'Get trace run tree',
      description:
        'Trace summary plus its run tree as an indented outline (status, type, name, latency, tokens, short run id, error). LangGraph plumbing spans are hidden by default; error runs are never hidden.',
      inputSchema: {
        traceId: traceIdField,
        focusRunId: z.string().optional().describe('Only render the subtree under this run.'),
        maxDepth: z.number().int().nonnegative().optional(),
        maxNodes: z.number().int().positive().max(2000).optional().describe('Default 200.'),
        hide: z
          .string()
          .optional()
          .describe(
            `Regex of run names to hide (children are promoted). Default ${DEFAULT_HIDE_PATTERN}; "" shows everything.`,
          ),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.getTrace(input)),
  );

  server.registerTool(
    'find_runs',
    {
      title: 'Find runs',
      description:
        'Find runs by structural fields (type, name, status, error message, latency, tokens, metadata) across one or more traces. Does not read payloads.',
      inputSchema: {
        traceIds: z
          .array(z.string().min(1))
          .optional()
          .describe('Defaults to the newest traceLimit traces.'),
        traceLimit: z.number().int().positive().max(500).optional().describe('Default 20.'),
        type: z.array(z.string()).optional().describe('Run types, e.g. ["tool", "chat_model"].'),
        name: z.string().optional().describe('Case-insensitive regex against run names.'),
        status: statusField.optional(),
        errorContains: z.string().optional(),
        minLatencyMs: z.number().nonnegative().optional(),
        minTokens: z.number().nonnegative().optional(),
        metadata: z.record(scalar).optional(),
        maxDepth: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional().describe('Default 50.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.findRuns(input)),
  );

  server.registerTool(
    'get_run',
    {
      title: 'Get run details',
      description:
        'Full details of one run: ancestry path, timing, tokens, full error, metadata, children, and short previews of its input/output payloads.',
      inputSchema: {
        traceId: traceIdField,
        runId: runIdField,
        previewChars: z
          .number()
          .int()
          .positive()
          .max(20_000)
          .optional()
          .describe('Default 1500 per payload.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.getRun(input)),
  );

  server.registerTool(
    'get_payload',
    {
      title: 'Get payload',
      description:
        'Read a run input/output payload. mode "outline" lists paths, types and sizes; "json" returns content (paged with offset); "auto" returns json when it fits, else the outline. Use `path` (JSONPath subset: $.a.b, [0], [-1], [*], .*) to read only part of it.',
      inputSchema: {
        traceId: traceIdField.optional(),
        runId: runIdField.optional(),
        side: sideField.optional().describe('Default output.'),
        ref: z
          .string()
          .optional()
          .describe('Raw payload ref, alternative to traceId + runId + side.'),
        path: z.string().optional(),
        mode: z.enum(['auto', 'json', 'outline']).optional(),
        offset: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().positive().max(50_000).optional().describe('Default 12000.'),
        outlineDepth: z.number().int().positive().max(12).optional().describe('Default 4.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.getPayload(input)),
  );

  server.registerTool(
    'load_trace_payloads',
    {
      title: 'Load trace payloads',
      description:
        'Load all input/output payloads of traces into the in-memory search index (required before search_payloads can search them). Pass traceIds, or omit them to load the newest `limit` traces matching status/projectId. Reloading a trace only fetches new payloads.',
      inputSchema: {
        traceIds: z.array(z.string().min(1)).optional(),
        status: statusField.optional(),
        projectId: z.string().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Default 10 when traceIds is omitted.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.loadTracePayloads(input)),
  );

  server.registerTool(
    'search_payloads',
    {
      title: 'Search payloads',
      description:
        'Full-text or regex search over loaded payload values. Results are grouped by identical value and point to the run, side and JSONPath where each value first appeared. Passing traceIds loads those traces automatically and searches only them; otherwise all loaded traces are searched.',
      inputSchema: {
        query: z.string().min(1),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        traceIds: z.array(z.string().min(1)).max(20).optional(),
        runType: z.array(z.string()).optional(),
        runName: z.string().optional().describe('Case-insensitive regex against run names.'),
        side: z.enum(['input', 'output', 'both']).optional(),
        pathPrefix: z
          .string()
          .optional()
          .describe('Only leaves under this path, e.g. "$.messages".'),
        maxGroups: z.number().int().positive().max(200).optional().describe('Default 30.'),
        offset: z.number().int().nonnegative().optional(),
        maxOccurrencesPerGroup: z
          .number()
          .int()
          .nonnegative()
          .max(100)
          .optional()
          .describe('Default 5.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.searchPayloads(input)),
  );

  server.registerTool(
    'analyze_trace',
    {
      title: 'Analyze trace',
      description:
        'Debugging report for a trace: root-cause error runs with ancestry, unfinished and orphan runs, critical path and self time, token hotspots, repeated identical calls (loops), and error-like values inside successful runs.',
      inputSchema: {
        traceId: traceIdField,
        loadPayloads: z
          .boolean()
          .optional()
          .describe('Load payloads for payload-based checks. Default true.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.analyzeTrace(input)),
  );

  server.registerTool(
    'get_conversation',
    {
      title: 'Get conversation',
      description:
        'Render the chat messages in a run input/output (OpenAI, Anthropic and LangChain message shapes) as a readable transcript including tool calls and tool call ids.',
      inputSchema: {
        traceId: traceIdField,
        runId: runIdField,
        side: z.enum(['input', 'output', 'both']).optional(),
        maxMessages: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe('Keeps the last N per sequence. Default 100.'),
        maxCharsPerMessage: z
          .number()
          .int()
          .positive()
          .max(50_000)
          .optional()
          .describe('Default 2000.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.getConversation(input)),
  );

  const compareTarget = z.object({ traceId: traceIdField, runId: z.string().optional() });
  server.registerTool(
    'compare',
    {
      title: 'Compare runs or traces',
      description:
        'With runId on both sides: diff run fields and input/output payloads path by path. Without runIds: align the two traces run by run (type, name, occurrence) and report status, structure, latency and token differences.',
      inputSchema: {
        a: compareTarget,
        b: compareTarget,
        side: z.enum(['input', 'output', 'both']).optional(),
        maxChanges: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe('Default 100 per side.'),
      },
      annotations: readOnly,
    },
    (input) => respond(() => tools.compare(input)),
  );

  server.registerTool(
    'annotate',
    {
      title: 'Annotate trace or run',
      description:
        'Write an annotation onto a trace (or one run with runId); it is persisted in the trace store and shown in the trace viewer. This modifies stored data: before calling, ask the user for permission and show them the exact annotation you intend to write. Annotations are merged into existing ones by default; prefer a single namespaced key such as { "agent_notes": "…" }.',
      inputSchema: {
        traceId: traceIdField,
        runId: runIdField.optional(),
        annotation: z.record(z.unknown()),
        merge: z
          .boolean()
          .optional()
          .describe('Default true. false replaces the whole annotation.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => respond(() => tools.annotate(input)),
  );

  return server;
}

/** Serves the trace MCP over stdio. Logs go to stderr; stdout carries the protocol. */
export async function startTraceMcpStdioServer(options: TraceMcpServerOptions): Promise<McpServer> {
  const server = createTraceMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
