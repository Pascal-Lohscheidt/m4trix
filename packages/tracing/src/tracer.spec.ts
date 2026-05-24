import { describe, expect, it } from 'vitest';
import { toLangGraph } from './adapters/langgraph.js';
import {
  type PayloadStoreAdapter,
  type StructureStoreAdapter,
  type Trace,
  type TraceRun,
  Tracer,
  TraceStore,
  TraceViewerApi,
} from './index.js';

describe('Tracer', () => {
  it('marks callback work as awaited for LangChain-compatible callback managers', () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    expect(tracer).toMatchObject({
      awaitHandlers: true,
      name: 'm4trix_tracer',
    });
  });

  it('adapt(toLangGraph) returns LangGraph callback surface with same behavior', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));
    const lgTracer = tracer.adapt(toLangGraph);

    expect(lgTracer).toMatchObject({
      awaitHandlers: true,
      name: 'm4trix_tracer',
    });
    expect(typeof lgTracer.flush).toBe('function');
    expect(typeof lgTracer.handleChainStart).toBe('function');
    expect(typeof lgTracer.handleChainEnd).toBe('function');

    await lgTracer.handleChainStart(
      { name: 'RootChain' },
      { question: 'hello' },
      'root-run',
      undefined,
      [],
      { projectId: 'demo', env: 'test' },
      'chain',
      'Root Chain',
    );
    await lgTracer.handleChainEnd({ answer: 'hi' }, 'root-run');
    await lgTracer.flush();

    expect(structureStoreAdapter.traces).toHaveLength(1);
    expect(structureStoreAdapter.traces[0]).toMatchObject({
      traceId: 'root-run',
      rootRunId: 'root-run',
      projectId: 'demo',
      status: 'success',
    });
  });

  it('captures LangChain-style start, end, and error callbacks into the TraceStore', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    await tracer.handleChainStart(
      { name: 'RootChain' },
      { question: 'hello' },
      'root-run',
      undefined,
      ['demo-tag'],
      { projectId: 'demo', env: 'test' },
      'chain',
      'Root Chain',
    );
    await tracer.handleChatModelStart(
      { model: 'mock-chat' },
      [[{ role: 'user', content: 'hello' }]],
      'chat-run',
      'root-run',
      undefined,
      ['demo-tag'],
      { provider: 'mock' },
      'Mock Chat',
    );
    await tracer.handleLLMEnd(
      {
        generations: [[{ text: 'hi there' }]],
        llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 4 } },
      },
      'chat-run',
    );
    await tracer.handleToolStart({ name: 'lookup' }, 'sunken trove', 'tool-run', 'root-run');
    await tracer.handleToolError(new Error('tool failed'), 'tool-run');
    await tracer.handleChainEnd({ answer: 'hi there' }, 'root-run');

    await tracer.flush();

    expect(structureStoreAdapter.traces).toHaveLength(1);
    expect(structureStoreAdapter.traces[0]).toMatchObject({
      metadata: { env: 'test' },
      name: 'Root Chain',
      projectId: 'demo',
      rootRunId: 'root-run',
      runCount: 3,
      status: 'error',
      traceId: 'root-run',
    });
    expect(structureStoreAdapter.batches).toHaveLength(1);
    expect(structureStoreAdapter.batches[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputRef: 'traces/root-run/payloads/root-run/input.json',
          outputRef: 'traces/root-run/payloads/root-run/output.json',
          runId: 'root-run',
          status: 'success',
          traceId: 'root-run',
          type: 'chain',
        }),
        expect.objectContaining({
          inputRef: 'traces/root-run/payloads/chat-run/input.json',
          outputRef: 'traces/root-run/payloads/chat-run/output.json',
          parentRunId: 'root-run',
          runId: 'chat-run',
          status: 'success',
          tokens: { input: 3, output: 4 },
          type: 'chat_model',
        }),
        expect.objectContaining({
          error: { message: 'tool failed', type: 'Error' },
          parentRunId: 'root-run',
          runId: 'tool-run',
          status: 'error',
          type: 'tool',
        }),
      ]),
    );
    await expect(
      payloadStoreAdapter.getJson('traces/root-run/payloads/chat-run/output.json'),
    ).resolves.toMatchObject({
      generations: [[{ text: 'hi there' }]],
    });
  });

  it('flushes successful callback runs with viewer-readable payload refs and tree data', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const traceStore = TraceStore.of({ payloadStoreAdapter, structureStoreAdapter });
    const tracer = Tracer.from(traceStore);

    await tracer.handleChainStart(
      { name: 'RootChain' },
      { question: 'hello' },
      'root-run',
      undefined,
      [],
      { projectId: 'demo', env: 'test' },
      'RootChain',
    );
    await tracer.handleToolStart(
      { name: 'SearchTool' },
      'search query',
      'tool-run',
      'root-run',
      [],
      { env: 'test' },
      'SearchTool',
    );
    await tracer.handleToolEnd({ result: 'found' }, 'tool-run');
    await tracer.handleChainEnd({ answer: 'world' }, 'root-run');
    await tracer.flush();

    expect(structureStoreAdapter.traces).toEqual([
      expect.objectContaining({
        traceId: 'root-run',
        rootRunId: 'root-run',
        projectId: 'demo',
        name: 'RootChain',
        status: 'success',
        runCount: 2,
      }),
    ]);
    await expect(
      payloadStoreAdapter.getJson('traces/root-run/payloads/root-run/input.json'),
    ).resolves.toEqual({
      question: 'hello',
    });
    await expect(
      payloadStoreAdapter.getJson('traces/root-run/payloads/tool-run/output.json'),
    ).resolves.toEqual({
      result: 'found',
    });

    const api = TraceViewerApi.from(traceStore);
    await expect(api.getTraceTree('root-run')).resolves.toEqual({
      trace: expect.objectContaining({ traceId: 'root-run', status: 'success' }),
      root: expect.objectContaining({
        runId: 'root-run',
        children: [expect.objectContaining({ runId: 'tool-run', children: [] })],
      }),
    });
  });

  it('waits for in-flight callback work before flushing structure rows', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    void tracer.handleChainStart(
      { name: 'RootChain' },
      { question: 'hello' },
      'root-run',
      undefined,
      [],
      { projectId: 'demo' },
      'RootChain',
    );

    await tracer.flush();

    expect(structureStoreAdapter.traces).toEqual([
      expect.objectContaining({
        traceId: 'root-run',
        rootRunId: 'root-run',
        projectId: 'demo',
        runCount: 1,
      }),
    ]);
    expect(structureStoreAdapter.batches).toEqual([
      [
        expect.objectContaining({
          runId: 'root-run',
          inputRef: 'traces/root-run/payloads/root-run/input.json',
        }),
      ],
    ]);
  });
});

class RecordingStructureStoreAdapter implements StructureStoreAdapter {
  readonly traces: Trace[] = [];
  readonly batches: TraceRun[][] = [];
  private readonly traceRecords = new Map<string, Trace>();
  private readonly runRecords = new Map<string, TraceRun>();

  async upsertTrace(trace: Trace): Promise<void> {
    this.traces.push(trace);
    this.traceRecords.set(trace.traceId, trace);
  }

  async upsertRun(run: TraceRun): Promise<void> {
    this.runRecords.set(run.runId, run);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    this.batches.push(runs);
    for (const run of runs) {
      this.runRecords.set(run.runId, run);
    }
  }

  async getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null> {
    const trace = this.traceRecords.get(traceId);
    if (!trace) return null;
    return {
      trace,
      runs: [...this.runRecords.values()].filter((run) => run.traceId === traceId),
    };
  }

  async listTraces(): Promise<{ traces: Trace[]; nextCursor?: string }> {
    return { traces: [...this.traceRecords.values()] };
  }

  async patchTraceAnnotation(): Promise<Trace | null> {
    return null;
  }

  async patchRunAnnotation(): Promise<TraceRun | null> {
    return null;
  }
}

class RecordingPayloadStoreAdapter implements PayloadStoreAdapter {
  private readonly payloads = new Map<string, unknown>();

  async putJson(path: string, value: unknown): Promise<string> {
    this.payloads.set(path, value);
    return path;
  }

  async getJson<T = unknown>(ref: string): Promise<T> {
    return this.payloads.get(ref) as T;
  }
}
