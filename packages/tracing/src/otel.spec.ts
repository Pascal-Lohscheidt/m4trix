import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  otelSpanId,
  otelTraceId,
  type TraceRecord,
  type TraceRun,
  Tracer,
  TraceStore,
} from './index.js';
import {
  OtlpHttpExporter,
  type OtlpSpan,
  resolveOtlpHttpExporterOptionsFromEnv,
  type TraceExporter,
  toOtlpSpans,
  toOtlpTraceRequest,
  withOtlpExport,
} from './otel.js';
import {
  RecordingPayloadStoreAdapter,
  RecordingStructureStoreAdapter,
} from './testing/recording-stores.js';

const T0 = '2026-03-01T10:00:00.000Z';
const T1 = '2026-03-01T10:00:01.500Z';

function run(overrides: Partial<TraceRun>): TraceRun {
  return {
    schemaVersion: 1,
    traceId: 'root',
    runId: 'root',
    type: 'chain',
    name: 'Root',
    status: 'success',
    startTime: T0,
    endTime: T1,
    ...overrides,
  };
}

const record: TraceRecord = {
  trace: {
    schemaVersion: 1,
    traceId: 'root',
    rootRunId: 'root',
    name: 'support-graph',
    status: 'error',
    startTime: T0,
    endTime: T1,
    runCount: 5,
    sessionId: 'thread-1',
    userId: 'user-1',
    projectId: 'support',
    annotation: {
      scores: {
        helpfulness: { value: 0.75, source: 'llm_judge', comment: 'fine', createdAt: T1 },
        verdict: { value: 'pass', createdAt: T1 },
      },
    },
  },
  runs: [
    run({ name: 'support-graph', tags: ['prod'], metadata: { env: 'prod' } }),
    run({
      runId: 'llm',
      parentRunId: 'root',
      type: 'chat_model',
      name: 'ChatOpenAI',
      model: 'gpt-4o-2024-08-06',
      provider: 'openai',
      tokens: { input: 120, output: 30, cached: 100, cacheCreation: 5, reasoning: 10 },
      timeToFirstTokenMs: 350,
      costUsd: 0.0012,
    }),
    run({
      runId: 'tool',
      parentRunId: 'llm',
      type: 'tool',
      name: 'search',
      status: 'error',
      error: { message: 'search down', type: 'TimeoutError' },
      extra: { toolCallId: 'call_1' },
    }),
    run({ runId: 'agent', parentRunId: 'root', type: 'agent', name: 'planner' }),
    run({ runId: 'pending', parentRunId: 'root', status: 'running', endTime: undefined }),
  ],
};

function attributes(span: OtlpSpan | undefined): Record<string, unknown> {
  return Object.fromEntries(
    (span?.attributes ?? []).map(({ key, value }) => [key, Object.values(value)[0]]),
  );
}

describe('toOtlpSpans', () => {
  const spans = toOtlpSpans(record);
  const byName = (name: string) => spans.find((span) => span.name === name);

  it('maps finished runs to spans of one OpenTelemetry trace with the run tree as parents', () => {
    expect(spans.map((span) => span.name)).toEqual([
      'invoke_workflow support-graph',
      'chat gpt-4o-2024-08-06',
      'execute_tool search',
      'invoke_agent planner',
    ]);
    expect(new Set(spans.map((span) => span.traceId))).toEqual(
      new Set([otelTraceId(record.trace)]),
    );
    expect(byName('invoke_workflow support-graph')).not.toHaveProperty('parentSpanId');
    expect(byName('chat gpt-4o-2024-08-06')).toMatchObject({
      spanId: otelSpanId('llm'),
      parentSpanId: otelSpanId('root'),
      kind: 3,
      startTimeUnixNano: '1772359200000000000',
      endTimeUnixNano: '1772359201500000000',
    });
    expect(byName('execute_tool search')).toMatchObject({
      parentSpanId: otelSpanId('llm'),
      kind: 1,
    });
  });

  it('sets GenAI semantic convention attributes', () => {
    expect(attributes(byName('chat gpt-4o-2024-08-06'))).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o-2024-08-06',
      'gen_ai.response.model': 'gpt-4o-2024-08-06',
      'gen_ai.usage.input_tokens': '120',
      'gen_ai.usage.output_tokens': '30',
      'gen_ai.usage.cache_read.input_tokens': '100',
      'gen_ai.usage.cache_write.input_tokens': '5',
      'gen_ai.usage.reasoning.output_tokens': '10',
      'gen_ai.response.time_to_first_chunk': 0.35,
      'gen_ai.conversation.id': 'thread-1',
      'm4trix.cost_usd': 0.0012,
      'm4trix.run.id': 'llm',
    });
    expect(attributes(byName('execute_tool search'))).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'search',
      'gen_ai.tool.call.id': 'call_1',
      'error.type': 'TimeoutError',
    });
    expect(attributes(byName('invoke_agent planner'))).toMatchObject({
      'gen_ai.agent.name': 'planner',
    });
    expect(attributes(byName('invoke_workflow support-graph'))).toMatchObject({
      'gen_ai.workflow.name': 'support-graph',
      'user.id': 'user-1',
      'm4trix.project.id': 'support',
      'm4trix.metadata.env': 'prod',
      'm4trix.tags': { values: [{ stringValue: 'prod' }] },
    });
  });

  it('marks failed runs with an error status', () => {
    expect(byName('execute_tool search')?.status).toEqual({ code: 2, message: 'search down' });
    expect(byName('invoke_agent planner')?.status).toEqual({ code: 0 });
  });

  it('attaches trace scores to the root span as evaluation events', () => {
    expect(byName('invoke_workflow support-graph')?.events).toEqual([
      {
        name: 'gen_ai.evaluation.result',
        timeUnixNano: '1772359201500000000',
        attributes: [
          { key: 'gen_ai.evaluation.name', value: { stringValue: 'helpfulness' } },
          { key: 'gen_ai.evaluation.score.value', value: { doubleValue: 0.75 } },
          { key: 'gen_ai.evaluation.explanation', value: { stringValue: 'fine' } },
        ],
      },
      {
        name: 'gen_ai.evaluation.result',
        timeUnixNano: '1772359201500000000',
        attributes: [
          { key: 'gen_ai.evaluation.name', value: { stringValue: 'verdict' } },
          { key: 'gen_ai.evaluation.score.label', value: { stringValue: 'pass' } },
        ],
      },
    ]);
  });

  it('tolerates a malformed score date, which users can edit into an annotation', () => {
    const scores = { quality: { value: 1, createdAt: 'yesterday' } };
    const [rootSpan] = toOtlpSpans({
      ...record,
      trace: { ...record.trace, annotation: { scores } },
    });

    expect(rootSpan.events?.[0].timeUnixNano).toBe(rootSpan.endTimeUnixNano);
  });

  it('joins the upstream trace when the trace continues a traceparent', () => {
    const remoteParent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true };
    const [rootSpan, childSpan] = toOtlpSpans({
      ...record,
      trace: { ...record.trace, remoteParent },
    });

    expect(rootSpan).toMatchObject({ traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16) });
    expect(childSpan.traceId).toBe('a'.repeat(32));
  });
});

describe('toOtlpTraceRequest', () => {
  it('wraps spans in a resource with the service name', () => {
    const request = toOtlpTraceRequest([record], {
      serviceName: 'support-api',
      resourceAttributes: { 'deployment.environment': 'prod' },
    });

    expect(request.resourceSpans[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'support-api' } },
      { key: 'deployment.environment', value: { stringValue: 'prod' } },
    ]);
    expect(request.resourceSpans[0].scopeSpans[0]).toMatchObject({
      scope: { name: '@m4trix/tracing' },
      spans: expect.arrayContaining([expect.objectContaining({ name: 'invoke_agent planner' })]),
    });
  });
});

/** A local stand-in for an OpenTelemetry Collector's OTLP/HTTP endpoint. */
async function startCollector(status = 200): Promise<{
  url: string;
  requests: { headers: IncomingHttpHeaders; body: ReturnType<typeof toOtlpTraceRequest> }[];
  server: Server;
}> {
  const requests: { headers: IncomingHttpHeaders; body: ReturnType<typeof toOtlpTraceRequest> }[] =
    [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ headers: request.headers, body: JSON.parse(body) });
      response.writeHead(status).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/traces`, requests, server };
}

describe('OtlpHttpExporter', () => {
  let collector: Awaited<ReturnType<typeof startCollector>>;

  afterEach(async () => {
    await new Promise((resolve) => collector.server.close(resolve));
  });

  it('posts OTLP/JSON with the configured headers', async () => {
    collector = await startCollector();
    const exporter = new OtlpHttpExporter({
      url: collector.url,
      serviceName: 'support-api',
      headers: { authorization: 'Bearer token' },
    });

    await exporter.export([record]);
    await exporter.export([]);

    expect(collector.requests).toHaveLength(1);
    expect(collector.requests[0].headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer token',
    });
    expect(collector.requests[0].body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(4);
  });

  it('rejects when the collector refuses the spans', async () => {
    collector = await startCollector(503);
    const exporter = new OtlpHttpExporter({ url: collector.url, serviceName: 'svc' });

    await expect(exporter.export([record])).rejects.toThrow('HTTP 503');
  });
});

describe('resolveOtlpHttpExporterOptionsFromEnv', () => {
  it('is off without an endpoint', () => {
    expect(resolveOtlpHttpExporterOptionsFromEnv({})).toBeUndefined();
  });

  it('appends the traces path to the base endpoint and reads service name and headers', () => {
    expect(
      resolveOtlpHttpExporterOptionsFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.com/',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc%3D, x-team = core ,broken',
        OTEL_SERVICE_NAME: 'support-api',
      }),
    ).toEqual({
      url: 'https://otlp.example.com/v1/traces',
      serviceName: 'support-api',
      headers: { 'x-api-key': 'abc=', 'x-team': 'core' },
    });
  });

  it('prefers the traces-specific endpoint and headers', () => {
    expect(
      resolveOtlpHttpExporterOptionsFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://base',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces/v1/traces',
        OTEL_EXPORTER_OTLP_HEADERS: 'a=1',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'b=2',
      }),
    ).toEqual({ url: 'https://traces/v1/traces', serviceName: 'm4trix', headers: { b: '2' } });
  });
});

describe('withOtlpExport', () => {
  const finished = (traceId: string, runStatus: TraceRun['status'] = 'success'): TraceRecord => ({
    trace: { ...record.trace, traceId, rootRunId: traceId, status: 'success' },
    runs: [run({ traceId, runId: traceId, status: runStatus })],
  });

  function setup(
    exporter: TraceExporter = { export: vi.fn(async () => {}) },
    options: { maxQueuedExports?: number; concurrency?: number } = {},
  ) {
    const inner = new RecordingStructureStoreAdapter();
    const onError = vi.fn();
    const store = withOtlpExport(inner, exporter, { onError, ...options });
    return { inner, store, exporter, onError };
  }

  it('exports a trace once, when it is written finished', async () => {
    const { store, exporter } = setup();
    const { trace, runs } = finished('t1');

    await store.upsertRunBatch?.(runs);
    await store.upsertTrace({ ...trace, status: 'running' });
    await store.drainExports();
    expect(exporter.export).not.toHaveBeenCalled();

    await store.upsertTrace(trace);
    await store.upsertTrace(trace);
    await store.drainExports();

    expect(exporter.export).toHaveBeenCalledTimes(1);
    expect(exporter.export).toHaveBeenCalledWith([{ trace, runs }]);
  });

  it('waits until background runs of a finished trace have ended', async () => {
    const { store, exporter } = setup();
    const { trace, runs } = finished('t1');
    const background = run({ traceId: 't1', runId: 'bg', parentRunId: 't1', status: 'running' });

    await store.upsertRunBatch?.([...runs, background]);
    await store.upsertTrace(trace);
    await store.drainExports();
    expect(exporter.export).not.toHaveBeenCalled();

    await store.upsertRunBatch?.([{ ...background, status: 'success', endTime: T1 }]);
    await store.upsertTrace(trace);
    await store.drainExports();
    expect(exporter.export).toHaveBeenCalledTimes(1);
  });

  it('never fails the write when the export fails, and retries on the next write', async () => {
    const exporter = {
      export: vi
        .fn()
        .mockRejectedValueOnce(new Error('collector down'))
        .mockResolvedValue(undefined),
    };
    const { store, inner, onError } = setup(exporter);
    const { trace, runs } = finished('t1');

    await store.upsertRunBatch?.(runs);
    await expect(store.upsertTrace(trace)).resolves.toBeUndefined();
    await store.drainExports();
    expect(inner.trace('t1')).toEqual(trace);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'collector down' }),
      't1',
    );

    await store.upsertTrace(trace);
    await store.drainExports();
    expect(exporter.export).toHaveBeenCalledTimes(2);
  });

  it('never makes store writes wait for a slow backend', async () => {
    let release: () => void = () => {};
    const exporter = {
      export: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    };
    const { store } = setup(exporter);
    const { trace, runs } = finished('t1');
    await store.upsertRunBatch?.(runs);

    await store.upsertTrace(trace);
    await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(1));
    let drained = false;
    const draining = store.drainExports().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(drained).toBe(false);

    release();
    await draining;
    expect(drained).toBe(true);
  });

  it('caps exports in flight and skips traces beyond the queue, exporting them when written again', async () => {
    const releases: (() => void)[] = [];
    const exporter = {
      export: vi.fn(
        (_records: TraceRecord[]) => new Promise<void>((resolve) => releases.push(resolve)),
      ),
    };
    const { store, onError } = setup(exporter, { concurrency: 1, maxQueuedExports: 1 });
    for (const id of ['t1', 't2', 't3']) {
      const { trace, runs } = finished(id);
      await store.upsertRunBatch?.(runs);
      await store.upsertTrace(trace);
    }
    // t1 is exporting, t2 waits in the queue, t3 did not fit.
    await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('queue is full') }),
      't3',
    );

    releases.shift()?.();
    await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await store.upsertTrace(finished('t3').trace);
    await vi.waitFor(() => expect(exporter.export).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await store.drainExports();

    expect(exporter.export.mock.calls.map(([records]) => records[0].trace.traceId)).toEqual([
      't1',
      't2',
      't3',
    ]);
  });

  it('delegates reads and annotation patches to the wrapped store', async () => {
    const { store, inner } = setup();
    const { trace, runs } = finished('t1');
    await inner.upsertRunBatch(runs);
    await inner.upsertTrace(trace);

    await expect(store.getTrace('t1')).resolves.toEqual({ trace, runs });
    await expect(store.listTraces()).resolves.toEqual({ traces: [trace] });
    await expect(
      store.patchTraceAnnotation({ traceId: 't1', annotation: { a: 1 } }),
    ).resolves.toMatchObject({
      annotation: { a: 1 },
    });
  });
});

describe('Tracer exporting to an OTLP collector', () => {
  let collector: Awaited<ReturnType<typeof startCollector>>;

  beforeEach(async () => {
    collector = await startCollector();
  });

  afterEach(async () => {
    await new Promise((resolve) => collector.server.close(resolve));
  });

  it('exports each finished trace once, with its whole run tree', async () => {
    const structureStoreAdapter = withOtlpExport(
      new RecordingStructureStoreAdapter(),
      new OtlpHttpExporter({ url: collector.url, serviceName: 'svc' }),
    );
    const tracer = Tracer.from(
      TraceStore.of({
        structureStoreAdapter,
        payloadStoreAdapter: new RecordingPayloadStoreAdapter(),
      }),
    );

    const request = tracer.startRun({ type: 'chain', name: 'request', sessionId: 'thread-9' });
    const model = tracer.startRun({
      type: 'chat_model',
      name: 'llm',
      parentRunId: request.runId,
      model: 'gpt-4o',
    });
    await tracer.flush();
    await model.end({ tokens: { input: 3, output: 4 } });
    await request.end();
    await tracer.flush();
    await tracer.flush();
    await structureStoreAdapter.drainExports();

    expect(collector.requests).toHaveLength(1);
    const spans = collector.requests[0].body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((span) => span.name).sort()).toEqual([
      'chat gpt-4o',
      'invoke_workflow request',
    ]);
    expect(attributes(spans.find((span) => span.name === 'chat gpt-4o'))).toMatchObject({
      'gen_ai.usage.input_tokens': '3',
      'gen_ai.conversation.id': 'thread-9',
    });
  });
});
