import { describe, expect, it } from 'vitest';
import {
  type PayloadStoreAdapter,
  type StructureStoreAdapter,
  type Trace,
  type TraceRun,
  TraceStore,
} from './index.js';

describe('TraceStore', () => {
  it('composes structure and payload adapters behind the public API', async () => {
    const structureStoreAdapter = new MemoryStructureStoreAdapter();
    const payloadStoreAdapter = new MemoryPayloadStoreAdapter();
    const store = TraceStore.of({ payloadStoreAdapter, structureStoreAdapter });
    const trace = makeTrace();
    const run = makeRun({ inputRef: 'traces/trace-1/payloads/run-1/input.json' });

    await store.upsertTrace(trace);
    await store.upsertRun(run);
    const ref = await store.putJsonPayload('traces/trace-1/payloads/run-1/input.json', {
      question: 'hello',
    });

    await expect(store.getTrace('trace-1')).resolves.toEqual({ trace, runs: [run] });
    await expect(store.getPayload(ref)).resolves.toEqual({ question: 'hello' });
    await expect(store.listTraces({ projectId: 'demo' })).resolves.toEqual({ traces: [trace] });
  });

  it('uses structure batch upserts when available', async () => {
    const structureStoreAdapter = new MemoryStructureStoreAdapter();
    const store = TraceStore.of({
      payloadStoreAdapter: new MemoryPayloadStoreAdapter(),
      structureStoreAdapter,
    });
    const runs = [makeRun({ runId: 'run-1' }), makeRun({ runId: 'run-2' })];

    await store.upsertRunBatch(runs);

    expect(structureStoreAdapter.batchCalls).toEqual([runs]);
  });
});

class MemoryStructureStoreAdapter implements StructureStoreAdapter {
  readonly batchCalls: TraceRun[][] = [];
  private readonly traces = new Map<string, Trace>();
  private readonly runs = new Map<string, TraceRun>();

  async upsertTrace(trace: Trace): Promise<void> {
    this.traces.set(trace.traceId, trace);
  }

  async upsertRun(run: TraceRun): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    this.batchCalls.push(runs);
    for (const run of runs) {
      this.runs.set(run.runId, run);
    }
  }

  async getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null> {
    const trace = this.traces.get(traceId);
    if (!trace) return null;

    return {
      trace,
      runs: [...this.runs.values()].filter((run) => run.traceId === traceId),
    };
  }

  async listTraces(): Promise<{ traces: Trace[] }> {
    return { traces: [...this.traces.values()] };
  }
}

class MemoryPayloadStoreAdapter implements PayloadStoreAdapter {
  private readonly payloads = new Map<string, unknown>();

  async putJson(path: string, value: unknown): Promise<string> {
    this.payloads.set(path, value);
    return path;
  }

  async getJson<T = unknown>(ref: string): Promise<T> {
    return this.payloads.get(ref) as T;
  }
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    schemaVersion: 1,
    traceId: 'trace-1',
    rootRunId: 'run-1',
    projectId: 'demo',
    name: 'Trace 1',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    runCount: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    schemaVersion: 1,
    traceId: 'trace-1',
    runId: 'run-1',
    type: 'chain',
    name: 'Run 1',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
