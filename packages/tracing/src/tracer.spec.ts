import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toLangGraph } from './adapters/langgraph.js';
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
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

describe('Tracer.flush', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-tracer-flush-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('does not lose runs when flushes overlap on a filesystem store', async () => {
    const tracer = Tracer.from(fsTraceStore(root));
    await tracer.handleChainStart({}, {}, 'root-run');
    await tracer.flush();

    for (let i = 0; i < 15; i++) {
      await tracer.handleChainStart({}, {}, `first-${i}`, 'root-run');
    }
    const firstFlush = tracer.flush();
    for (let i = 0; i < 15; i++) {
      void tracer.handleChainStart({}, {}, `second-${i}`, 'root-run');
    }
    const secondFlush = tracer.flush();
    await Promise.all([firstFlush, secondFlush]);

    const lines = (await readFile(join(root, 'traces', 'root-run', 'runs.ndjson'), 'utf-8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(31);
  });

  it('never writes to the structure store from two flushes at once', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    structureStoreAdapter.writeDelayMs = 5;
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    await tracer.handleChainStart({}, {}, 'root-run');
    const firstFlush = tracer.flush();
    await tracer.handleChainStart({}, {}, 'child-run', 'root-run');
    await tracer.handleChainEnd({}, 'child-run');
    await tracer.handleChainEnd({}, 'root-run');
    const secondFlush = tracer.flush();
    await Promise.all([firstFlush, secondFlush]);

    expect(structureStoreAdapter.maxActiveWrites).toBe(1);
    expect(structureStoreAdapter.traces.at(-1)).toMatchObject({
      status: 'success',
      runCount: 2,
    });
  });

  it('re-queues runs and traces when a store write fails', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    structureStoreAdapter.failNextWrites = 1;
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    await tracer.handleChainStart({}, {}, 'root-run');
    await tracer.handleChainEnd({}, 'root-run');
    await expect(tracer.flush()).rejects.toThrow('structure store unavailable');
    expect(structureStoreAdapter.batches).toHaveLength(0);

    await tracer.flush();

    expect(structureStoreAdapter.batches).toEqual([
      [expect.objectContaining({ runId: 'root-run', status: 'success' })],
    ]);
    expect(structureStoreAdapter.traces).toEqual([
      expect.objectContaining({ traceId: 'root-run', status: 'success' }),
    ]);
  });

  it('keeps a newer pending run when re-queueing after a failed write', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    structureStoreAdapter.failNextWrites = 1;
    structureStoreAdapter.writeDelayMs = 5;
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    await tracer.handleChainStart({}, {}, 'root-run');
    const failedFlush = tracer.flush();
    // Let the failing flush take its snapshot before the run moves on.
    await new Promise((resolve) => setTimeout(resolve, 1));
    await tracer.handleChainEnd({}, 'root-run');
    await expect(failedFlush).rejects.toThrow('structure store unavailable');

    await tracer.flush();

    expect(structureStoreAdapter.batches).toEqual([
      [expect.objectContaining({ runId: 'root-run', status: 'success' })],
    ]);
  });

  it('keeps an annotation added while the trace is still running', async () => {
    const traceStore = fsTraceStore(root);
    const tracer = Tracer.from(traceStore);

    await tracer.handleChainStart({}, {}, 'root-run');
    await tracer.handleChainStart({}, {}, 'child-run', 'root-run');
    await tracer.flush();
    await traceStore.patchTraceAnnotation({ traceId: 'root-run', annotation: { verdict: 'bad' } });
    await traceStore.patchRunAnnotation({
      traceId: 'root-run',
      runId: 'child-run',
      annotation: { note: 'slow' },
    });

    await tracer.handleChainEnd({}, 'child-run');
    await tracer.handleChainEnd({}, 'root-run');
    await tracer.flush();

    const record = await traceStore.getTrace('root-run');
    expect(record?.trace).toMatchObject({ status: 'success', annotation: { verdict: 'bad' } });
    expect(record?.runs.find((run) => run.runId === 'child-run')).toMatchObject({
      status: 'success',
      annotation: { note: 'slow' },
    });
  });
});

describe('Tracer trace lifecycle', () => {
  it('adds up token usage from every run into the trace', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));
    const usage = (promptTokens: number, completionTokens: number) => ({
      llmOutput: { tokenUsage: { promptTokens, completionTokens } },
    });

    await tracer.handleChainStart({}, {}, 'root-run');
    await tracer.handleChatModelStart({}, [], 'llm-1', 'root-run');
    await tracer.handleLLMEnd(usage(100, 20), 'llm-1');
    await tracer.handleChainStart({}, {}, 'agent-run', 'root-run');
    await tracer.handleChatModelStart({}, [], 'llm-2', 'agent-run');
    await tracer.handleLLMEnd(usage(30, 5), 'llm-2');
    await tracer.handleChainEnd({}, 'agent-run');
    await tracer.handleChainEnd({}, 'root-run');
    await tracer.flush();

    expect(structureStoreAdapter.traces.at(-1)).toMatchObject({
      traceId: 'root-run',
      runCount: 4,
      tokens: { input: 130, output: 25 },
    });
  });

  it('releases a trace from memory once it has finished and been flushed', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    for (let i = 0; i < 20; i++) {
      await tracer.handleChainStart({}, {}, `root-${i}`);
      await tracer.handleChainStart({}, {}, `child-${i}`, `root-${i}`);
      await tracer.handleChainEnd({}, `child-${i}`);
      await tracer.handleChainEnd({}, `root-${i}`);
    }
    expect(tracer.activeTraceCount).toBe(20);

    await tracer.flush();

    expect(tracer.activeTraceCount).toBe(0);
    expect(structureStoreAdapter.traces).toHaveLength(20);
  });

  it('keeps a trace in memory until its last child run ends', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    await tracer.handleChainStart({}, {}, 'root-run');
    await tracer.handleToolStart({}, 'query', 'background-tool', 'root-run');
    await tracer.handleChainEnd({}, 'root-run');
    await tracer.flush();
    expect(tracer.activeTraceCount).toBe(1);

    await tracer.handleToolEnd({ result: 'late' }, 'background-tool');
    await tracer.flush();

    expect(tracer.activeTraceCount).toBe(0);
    expect(structureStoreAdapter.batches.at(-1)).toEqual([
      expect.objectContaining({ runId: 'background-tool', status: 'success' }),
    ]);
    expect(structureStoreAdapter.traces.at(-1)).toMatchObject({
      traceId: 'root-run',
      status: 'success',
      runCount: 2,
    });
  });

  it('keeps a finished trace in memory until a flush succeeds', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    structureStoreAdapter.failNextWrites = 1;
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));

    await tracer.handleChainStart({}, {}, 'root-run', undefined, [], { projectId: 'demo' });
    await tracer.handleChainEnd({}, 'root-run');
    await expect(tracer.flush()).rejects.toThrow('structure store unavailable');
    expect(tracer.activeTraceCount).toBe(1);

    await tracer.flush();

    expect(tracer.activeTraceCount).toBe(0);
    expect(structureStoreAdapter.traces).toEqual([
      expect.objectContaining({ traceId: 'root-run', projectId: 'demo', status: 'success' }),
    ]);
  });
});

function fsTraceStore(root: string): TraceStore {
  return TraceStore.of({
    structureStoreAdapter: new FsStructureStoreAdapter({ path: root }),
    payloadStoreAdapter: new FsPayloadStoreAdapter({ path: root }),
  });
}

class RecordingStructureStoreAdapter implements StructureStoreAdapter {
  readonly traces: Trace[] = [];
  readonly batches: TraceRun[][] = [];
  writeDelayMs = 0;
  failNextWrites = 0;
  maxActiveWrites = 0;
  private activeWrites = 0;
  private readonly traceRecords = new Map<string, Trace>();
  private readonly runRecords = new Map<string, TraceRun>();

  async upsertTrace(trace: Trace): Promise<void> {
    await this.write(() => {
      this.traces.push(trace);
      this.traceRecords.set(trace.traceId, trace);
    });
  }

  async upsertRun(run: TraceRun): Promise<void> {
    this.runRecords.set(run.runId, run);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    await this.write(() => {
      this.batches.push(runs);
      for (const run of runs) {
        this.runRecords.set(run.runId, run);
      }
    });
  }

  private async write(apply: () => void): Promise<void> {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (this.writeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
      }
      if (this.failNextWrites > 0) {
        this.failNextWrites -= 1;
        throw new Error('structure store unavailable');
      }
      apply();
    } finally {
      this.activeWrites -= 1;
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
