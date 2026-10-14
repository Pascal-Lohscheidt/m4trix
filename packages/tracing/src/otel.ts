/**
 * OpenTelemetry export: maps traces to OTLP/JSON spans following the GenAI semantic conventions,
 * so they can go to any OTLP backend (an OpenTelemetry Collector, Jaeger, Honeycomb, Datadog...).
 * No OpenTelemetry SDK needed. Payload contents (prompts, outputs) are not exported.
 */
import { readScores } from './scores.js';
import { otelSpanId, otelTraceId } from './trace-context.js';
import type { StructureStoreAdapter, Trace, TraceRecord, TraceRun } from './types.js';

export type OtlpAttributeValue = string | number | boolean | string[];

export type OtlpMappingOptions = {
  /** `service.name` of the exported resource. */
  serviceName: string;
  resourceAttributes?: Record<string, OtlpAttributeValue>;
};

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };

type KeyValue = { key: string; value: AnyValue };

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events?: { name: string; timeUnixNano: string; attributes: KeyValue[] }[];
  status: { code: number; message?: string };
};

/** An OTLP `ExportTraceServiceRequest` in its JSON encoding. */
export type OtlpTraceRequest = {
  resourceSpans: {
    resource: { attributes: KeyValue[] };
    scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
  }[];
};

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

export function toOtlpTraceRequest(
  records: TraceRecord[],
  options: OtlpMappingOptions,
): OtlpTraceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toKeyValues({
            'service.name': options.serviceName,
            ...options.resourceAttributes,
          }),
        },
        scopeSpans: [
          {
            scope: { name: '@m4trix/tracing' },
            spans: records.flatMap((record) => toOtlpSpans(record)),
          },
        ],
      },
    ],
  };
}

/** Spans of a trace's finished runs; runs still running are left out. */
export function toOtlpSpans(record: TraceRecord): OtlpSpan[] {
  const { trace } = record;
  const traceId = otelTraceId(trace);
  return record.runs.filter((run) => run.endTime).map((run) => toSpan(trace, traceId, run));
}

function toSpan(trace: Trace, traceId: string, run: TraceRun): OtlpSpan {
  const isRoot = run.runId === trace.rootRunId;
  const operation = operationOf(run, isRoot);
  const parentSpanId = isRoot
    ? trace.remoteParent?.spanId
    : run.parentRunId
      ? otelSpanId(run.parentRunId)
      : undefined;
  const scores = isRoot ? readScores(trace.annotation) : readScores(run.annotation);
  const tokens = run.tokens;
  const toolCallId = typeof run.extra?.toolCallId === 'string' ? run.extra.toolCallId : undefined;

  const attributes: Record<string, OtlpAttributeValue | undefined> = {
    'gen_ai.operation.name': operation?.name,
    'gen_ai.provider.name': run.provider,
    'gen_ai.request.model': run.model,
    'gen_ai.response.model': run.model,
    'gen_ai.usage.input_tokens': tokens?.input,
    'gen_ai.usage.output_tokens': tokens?.output,
    'gen_ai.usage.cache_read.input_tokens': tokens?.cached,
    'gen_ai.usage.cache_write.input_tokens': tokens?.cacheCreation,
    'gen_ai.usage.reasoning.output_tokens': tokens?.reasoning,
    'gen_ai.response.time_to_first_chunk':
      run.timeToFirstTokenMs === undefined ? undefined : run.timeToFirstTokenMs / 1000,
    'gen_ai.tool.name': run.type === 'tool' ? run.name : undefined,
    'gen_ai.tool.call.id': toolCallId,
    'gen_ai.agent.name': run.type === 'agent' ? run.name : undefined,
    'gen_ai.workflow.name': operation?.name === 'invoke_workflow' ? run.name : undefined,
    'gen_ai.conversation.id': trace.sessionId,
    'user.id': isRoot ? trace.userId : undefined,
    'error.type': run.status === 'error' ? (run.error?.type ?? '_OTHER') : undefined,
    'm4trix.trace.id': trace.traceId,
    'm4trix.run.id': run.runId,
    'm4trix.run.type': run.type,
    'm4trix.project.id': isRoot ? trace.projectId : undefined,
    'm4trix.cost_usd': run.costUsd,
    'm4trix.tags': run.tags,
    ...Object.fromEntries(
      Object.entries(run.metadata ?? {}).map(([key, value]) => [`m4trix.metadata.${key}`, value]),
    ),
  };

  const endTimeUnixNano = toUnixNano(run.endTime ?? run.startTime);
  const events = Object.entries(scores).map(([name, score]) => ({
    name: 'gen_ai.evaluation.result',
    // Annotations are user-editable; fall back to the span end for a malformed date.
    timeUnixNano: toUnixNano(score.createdAt, endTimeUnixNano),
    attributes: toKeyValues({
      'gen_ai.evaluation.name': name,
      ...(typeof score.value === 'number'
        ? { 'gen_ai.evaluation.score.value': score.value }
        : { 'gen_ai.evaluation.score.label': String(score.value) }),
      'gen_ai.evaluation.explanation': score.comment,
    }),
  }));

  return {
    traceId,
    spanId: otelSpanId(run.runId),
    ...(parentSpanId ? { parentSpanId } : {}),
    name: operation ? `${operation.name} ${operation.subject ?? ''}`.trim() : run.name,
    kind: operation?.client ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(run.startTime),
    endTimeUnixNano,
    attributes: toKeyValues(attributes),
    ...(events.length > 0 ? { events } : {}),
    status:
      run.status === 'error'
        ? { code: STATUS_ERROR, ...(run.error?.message ? { message: run.error.message } : {}) }
        : { code: STATUS_UNSET },
  };
}

/** The GenAI operation a run performs, with what the span name should mention. */
function operationOf(
  run: TraceRun,
  isRoot: boolean,
): { name: string; subject?: string; client?: boolean } | undefined {
  switch (run.type) {
    case 'chat_model':
      return { name: 'chat', subject: run.model, client: true };
    case 'llm':
      return { name: 'text_completion', subject: run.model, client: true };
    case 'embedding':
      return { name: 'embeddings', subject: run.model, client: true };
    case 'retriever':
      return { name: 'retrieval', subject: run.name, client: true };
    case 'tool':
      return { name: 'execute_tool', subject: run.name };
    case 'agent':
      return { name: 'invoke_agent', subject: run.name };
    default:
      return isRoot ? { name: 'invoke_workflow', subject: run.name } : undefined;
  }
}

function toKeyValues(attributes: Record<string, OtlpAttributeValue | undefined>): KeyValue[] {
  return Object.entries(attributes).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value: toAnyValue(value) }],
  );
}

function toAnyValue(value: OtlpAttributeValue): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toAnyValue) } };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function toUnixNano(iso: string, fallback = '0'): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? (BigInt(ms) * 1_000_000n).toString() : fallback;
}

/** Sends traces somewhere; {@link OtlpHttpExporter} is the standard one. */
export type TraceExporter = {
  export(records: TraceRecord[]): Promise<void>;
};

export type OtlpHttpExporterOptions = OtlpMappingOptions & {
  /** Defaults to `http://localhost:4318/v1/traces`, a local OpenTelemetry Collector. */
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/** Posts traces as OTLP/JSON over HTTP. `export` rejects when the backend does not accept them. */
export class OtlpHttpExporter implements TraceExporter {
  private readonly url: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: OtlpHttpExporterOptions) {
    this.url = options.url ?? 'http://localhost:4318/v1/traces';
    this.fetch = options.fetch ?? fetch;
  }

  async export(records: TraceRecord[]): Promise<void> {
    if (records.length === 0) return;
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.options.headers },
      body: JSON.stringify(toOtlpTraceRequest(records, this.options)),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      throw new Error(`OTLP export to ${this.url} failed: HTTP ${response.status}`);
    }
  }
}

/**
 * Exporter options from the standard OpenTelemetry environment variables, or `undefined` when no
 * endpoint is configured: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or `OTEL_EXPORTER_OTLP_ENDPOINT`
 * plus `/v1/traces`), `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS`
 * (`key=value,...`), and `OTEL_SERVICE_NAME`.
 */
export function resolveOtlpHttpExporterOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): OtlpHttpExporterOptions | undefined {
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '');
  const url = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || (base ? `${base}/v1/traces` : undefined);
  if (!url) return undefined;

  const headers = parseHeaders(
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
  );
  return {
    url,
    serviceName: env.OTEL_SERVICE_NAME || 'm4trix',
    ...(headers ? { headers } : {}),
  };
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = value.split(',').flatMap((pair) => {
    const separator = pair.indexOf('=');
    if (separator <= 0) return [];
    const key = pair.slice(0, separator).trim();
    return key ? [[key, decodeURIComponent(pair.slice(separator + 1).trim())]] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export type OtlpExportStoreOptions = {
  /** Export failures land here; they never fail the storage write. Defaults to `console.warn`. */
  onError?: (error: unknown, traceId: string) => void;
  /** Exports in flight at once. Defaults to 4. */
  concurrency?: number;
  /** Finished traces waiting to be exported; beyond this they are skipped and reported. Defaults to 1 000. */
  maxQueuedExports?: number;
};

/** A structure store that also exports finished traces; see {@link withOtlpExport}. */
export type OtlpExportingStore = StructureStoreAdapter & {
  /** Resolves once every queued export has settled. Await it before the process exits. */
  drainExports(): Promise<void>;
};

const MAX_REMEMBERED_EXPORTS = 10_000;

/**
 * Wraps a structure store so every trace is also exported once it has finished: when it is
 * written with a final status and none of its runs is still running. Works wherever the store is
 * written, in the app or in the sidecar.
 *
 * Exports run in the background, so a slow or unreachable backend never slows down the store
 * writes; call `drainExports()` before exiting. A trace whose export fails, or that was skipped
 * because the queue was full, is exported if it is written again.
 */
export function withOtlpExport(
  adapter: StructureStoreAdapter,
  exporter: TraceExporter,
  options: OtlpExportStoreOptions = {},
): OtlpExportingStore {
  const onError =
    options.onError ??
    ((error: unknown, traceId: string) =>
      console.warn(`[m4trix/tracing] OTLP export of trace ${traceId} failed`, error));
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxQueued = Math.max(1, options.maxQueuedExports ?? 1_000);
  /** Traces queued, being exported, or exported: each is exported once. */
  const claimed = new Set<string>();
  const queue: string[] = [];
  let active = 0;
  let waiters: (() => void)[] = [];

  const report = (error: unknown, traceId: string): void => {
    try {
      onError(error, traceId);
    } catch {
      // A failing error handler must not break exports.
    }
  };

  const claim = (traceId: string): void => {
    claimed.add(traceId);
    if (claimed.size > MAX_REMEMBERED_EXPORTS) {
      claimed.delete(claimed.values().next().value as string);
    }
  };

  const exportTrace = async (traceId: string): Promise<void> => {
    try {
      const record = await adapter.getTrace(traceId);
      if (!record || record.runs.some((run) => run.status === 'running')) {
        claimed.delete(traceId);
        return;
      }
      await exporter.export([record]);
    } catch (error) {
      claimed.delete(traceId);
      report(error, traceId);
    }
  };

  const pump = (): void => {
    while (active < concurrency && queue.length > 0) {
      const traceId = queue.shift() as string;
      active += 1;
      void exportTrace(traceId).finally(() => {
        active -= 1;
        pump();
        if (active === 0 && queue.length === 0) {
          const settled = waiters;
          waiters = [];
          for (const resolve of settled) resolve();
        }
      });
    }
  };

  const enqueue = (trace: Trace): void => {
    if (trace.status === 'running' || claimed.has(trace.traceId)) return;
    if (queue.length >= maxQueued) {
      report(new Error(`OTLP export queue is full (${maxQueued} traces); skipped`), trace.traceId);
      return;
    }
    claim(trace.traceId);
    queue.push(trace.traceId);
    pump();
  };

  return {
    upsertTrace: async (trace) => {
      await adapter.upsertTrace(trace);
      enqueue(trace);
    },
    upsertRun: (run) => adapter.upsertRun(run),
    ...(adapter.upsertRunBatch
      ? {
          upsertRunBatch: (runs: TraceRun[]) => adapter.upsertRunBatch?.(runs) ?? Promise.resolve(),
        }
      : {}),
    getTrace: (traceId) => adapter.getTrace(traceId),
    listTraces: (query) => adapter.listTraces(query),
    patchTraceAnnotation: (input) => adapter.patchTraceAnnotation(input),
    patchRunAnnotation: (input) => adapter.patchRunAnnotation(input),
    drainExports: () =>
      active === 0 && queue.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push(resolve)),
  };
}
