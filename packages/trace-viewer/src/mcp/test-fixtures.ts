import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  type Trace,
  type TraceRun,
  TraceStore,
  type TraceViewerApi,
} from '@m4trix/tracing';
import { createFsTraceViewerApi } from '../fs-setup';

export const FAILING_TRACE_ID = 'aaaa1111-0000-4000-8000-000000000001';
export const PASSING_TRACE_ID = 'bbbb2222-0000-4000-8000-000000000002';

type RunSpec = Omit<
  TraceRun,
  'schemaVersion' | 'traceId' | 'inputRef' | 'outputRef' | 'startTime'
> & {
  offsetMs: number;
  input?: unknown;
  output?: unknown;
};

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

const aiToolCall = {
  generations: [
    [
      {
        text: '',
        message: {
          lc: 1,
          type: 'constructor',
          id: ['langchain_core', 'messages', 'AIMessage'],
          kwargs: {
            content: '',
            tool_calls: [{ name: 'lookup_order', args: { orderId: 42 }, id: 'call_1' }],
          },
        },
      },
    ],
  ],
};

const chatInput = {
  messages: [
    { role: 'system', content: 'You are a support agent.' },
    { role: 'user', content: 'Where is my order 42?' },
  ],
};

async function writeTrace(
  store: TraceStore,
  trace: Trace,
  specs: RunSpec[],
  dayOffset: number,
): Promise<void> {
  const runs: TraceRun[] = [];
  for (const spec of specs) {
    const { offsetMs, input, output, ...rest } = spec;
    const base = `traces/${trace.traceId}/payloads/${spec.runId}`;
    const inputRef =
      input === undefined ? undefined : await store.putJsonPayload(`${base}/input.json`, input);
    const outputRef =
      output === undefined ? undefined : await store.putJsonPayload(`${base}/output.json`, output);
    runs.push({
      schemaVersion: 1,
      traceId: trace.traceId,
      startTime: new Date(BASE_TIME + dayOffset * 86_400_000 + offsetMs).toISOString(),
      ...(inputRef ? { inputRef } : {}),
      ...(outputRef ? { outputRef } : {}),
      ...rest,
    });
  }
  await store.upsertRunBatch(runs);
  await store.upsertTrace(trace);
}

/**
 * Two traces of a support agent: one failing (tool timeout, repeated cache misses, a run
 * that never ended, LangGraph noise spans) and one passing.
 */
export async function createFixtureTraceApi(): Promise<{ api: TraceViewerApi; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'm4trix-trace-mcp-'));
  const store = TraceStore.of({
    structureStoreAdapter: new FsStructureStoreAdapter({ path: dir }),
    payloadStoreAdapter: new FsPayloadStoreAdapter({ path: dir }),
  });

  const cacheRun = (index: number): RunSpec => ({
    runId: `a-cache-${index}`,
    parentRunId: FAILING_TRACE_ID,
    type: 'tool',
    name: 'cache_get',
    status: 'success',
    latencyMs: 5,
    offsetMs: 100 + index,
    input: { key: 'order:42' },
    output: { value: null, error: 'cache miss for order:42' },
  });

  await writeTrace(
    store,
    {
      schemaVersion: 1,
      traceId: FAILING_TRACE_ID,
      rootRunId: FAILING_TRACE_ID,
      name: 'support-agent',
      status: 'error',
      startTime: new Date(BASE_TIME).toISOString(),
      latencyMs: 5000,
      runCount: 8,
      metadata: { env: 'dev' },
    },
    [
      {
        runId: FAILING_TRACE_ID,
        type: 'chain',
        name: 'support-agent',
        status: 'error',
        latencyMs: 5000,
        offsetMs: 0,
        input: { question: 'Where is my order 42?' },
        error: { message: 'Tool lookup_order failed', type: 'ToolError' },
      },
      {
        runId: 'a-noise',
        parentRunId: FAILING_TRACE_ID,
        type: 'chain',
        name: 'ChannelWrite<...>',
        status: 'success',
        latencyMs: 1,
        offsetMs: 10,
      },
      cacheRun(1),
      cacheRun(2),
      cacheRun(3),
      {
        runId: 'a-llm',
        parentRunId: FAILING_TRACE_ID,
        type: 'chat_model',
        name: 'ChatOpenAI',
        status: 'success',
        latencyMs: 1200,
        tokens: { input: 500, output: 80 },
        offsetMs: 200,
        input: chatInput,
        output: aiToolCall,
      },
      {
        runId: 'a-tool',
        parentRunId: FAILING_TRACE_ID,
        type: 'tool',
        name: 'lookup_order',
        status: 'error',
        latencyMs: 3000,
        offsetMs: 1500,
        input: '{"orderId":42}',
        error: { message: 'Order service timeout after 3000ms', type: 'TimeoutError' },
      },
      {
        runId: 'a-notify',
        parentRunId: FAILING_TRACE_ID,
        type: 'tool',
        name: 'notify_user',
        status: 'running',
        offsetMs: 4600,
        input: { text: 'Sorry, something went wrong.' },
      },
    ],
    0,
  );

  await writeTrace(
    store,
    {
      schemaVersion: 1,
      traceId: PASSING_TRACE_ID,
      rootRunId: PASSING_TRACE_ID,
      name: 'support-agent',
      status: 'success',
      startTime: new Date(BASE_TIME + 86_400_000).toISOString(),
      latencyMs: 900,
      runCount: 3,
      metadata: { env: 'prod' },
    },
    [
      {
        runId: PASSING_TRACE_ID,
        type: 'chain',
        name: 'support-agent',
        status: 'success',
        latencyMs: 900,
        offsetMs: 0,
        input: { question: 'Where is my order 42?' },
        output: { answer: 'Order 42 has shipped.' },
      },
      {
        runId: 'b-llm',
        parentRunId: PASSING_TRACE_ID,
        type: 'chat_model',
        name: 'ChatOpenAI',
        status: 'success',
        latencyMs: 400,
        tokens: { input: 500, output: 80 },
        offsetMs: 10,
        input: chatInput,
        output: aiToolCall,
      },
      {
        runId: 'b-tool',
        parentRunId: PASSING_TRACE_ID,
        type: 'tool',
        name: 'lookup_order',
        status: 'success',
        latencyMs: 300,
        offsetMs: 500,
        input: '{"orderId":42}',
        output: { orderId: 42, status: 'shipped' },
      },
    ],
    1,
  );

  return { api: createFsTraceViewerApi(dir), dir };
}
