import { describe, expect, it } from 'vitest';
import {
  type PayloadStoreAdapter,
  type StructureStoreAdapter,
  type Trace,
  type TraceRun,
  TraceStore,
  TraceViewerApi,
} from './index.js';

describe('TraceViewerApi', () => {
  it('lists traces and reads trace records through TraceStore', async () => {
    const structureStoreAdapter = new MemoryStructureStoreAdapter();
    const payloadStoreAdapter = new MemoryPayloadStoreAdapter();
    const api = TraceViewerApi.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));
    await structureStoreAdapter.upsertTrace(makeTrace());
    await structureStoreAdapter.upsertRun(makeRun({ runId: 'root' }));

    await expect(api.listTraces({ projectId: 'demo' })).resolves.toEqual({
      traces: [makeTrace()],
    });
    await expect(api.getTrace('trace-1')).resolves.toEqual({
      trace: makeTrace(),
      runs: [makeRun({ runId: 'root' })],
    });
  });

  it('assembles runs into a start-time ordered parent-child tree', async () => {
    const trace = makeTrace();
    const runs = [
      makeRun({ runId: 'root', name: 'Root' }),
      makeRun({
        runId: 'child-2',
        parentRunId: 'root',
        name: 'Second child',
        startTime: '2026-01-01T00:00:02.000Z',
      }),
      makeRun({
        runId: 'child-1',
        parentRunId: 'root',
        name: 'First child',
        startTime: '2026-01-01T00:00:01.000Z',
      }),
      makeRun({ runId: 'grandchild', parentRunId: 'child-1', name: 'Grandchild' }),
    ];
    const api = TraceViewerApi.from(
      TraceStore.of({
        payloadStoreAdapter: new MemoryPayloadStoreAdapter(),
        structureStoreAdapter: new StaticStructureStoreAdapter(trace, runs),
      }),
    );

    await expect(api.getTraceTree('trace-1')).resolves.toEqual({
      trace,
      root: {
        ...runs[0],
        children: [
          {
            ...runs[2],
            children: [{ ...runs[3], children: [] }],
          },
          {
            ...runs[1],
            children: [],
          },
        ],
      },
    });
  });

  it('returns null when a trace tree cannot be found or has no root run', async () => {
    const missingApi = TraceViewerApi.from(
      TraceStore.of({
        payloadStoreAdapter: new MemoryPayloadStoreAdapter(),
        structureStoreAdapter: new MemoryStructureStoreAdapter(),
      }),
    );
    const rootlessApi = TraceViewerApi.from(
      TraceStore.of({
        payloadStoreAdapter: new MemoryPayloadStoreAdapter(),
        structureStoreAdapter: new StaticStructureStoreAdapter(makeTrace(), [
          makeRun({ parentRunId: 'missing-root' }),
        ]),
      }),
    );

    await expect(missingApi.getTraceTree('missing')).resolves.toBeNull();
    await expect(rootlessApi.getTraceTree('trace-1')).resolves.toBeNull();
  });

  it('resolves payload refs', async () => {
    const payloadStoreAdapter = new MemoryPayloadStoreAdapter();
    const api = TraceViewerApi.from(
      TraceStore.of({
        payloadStoreAdapter,
        structureStoreAdapter: new MemoryStructureStoreAdapter(),
      }),
    );
    const ref = await payloadStoreAdapter.putJson('payload.json', { answer: 42 });

    await expect(api.getPayload(ref)).resolves.toEqual({ answer: 42 });
  });
});

class StaticStructureStoreAdapter implements StructureStoreAdapter {
  constructor(
    private readonly trace: Trace,
    private readonly runs: TraceRun[],
  ) {}

  async upsertTrace(): Promise<void> {}

  async upsertRun(): Promise<void> {}

  async getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null> {
    if (traceId !== this.trace.traceId) return null;
    return { trace: this.trace, runs: this.runs };
  }

  async listTraces(): Promise<{ traces: Trace[] }> {
    return { traces: [this.trace] };
  }
}

class MemoryStructureStoreAdapter implements StructureStoreAdapter {
  private readonly traces = new Map<string, Trace>();
  private readonly runs = new Map<string, TraceRun>();

  async upsertTrace(trace: Trace): Promise<void> {
    this.traces.set(trace.traceId, trace);
  }

  async upsertRun(run: TraceRun): Promise<void> {
    this.runs.set(run.runId, run);
  }

  async getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null> {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    return {
      trace,
      runs: [...this.runs.values()].filter((run) => run.traceId === traceId),
    };
  }

  async listTraces(): Promise<{ traces: Trace[]; nextCursor?: string }> {
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
    rootRunId: 'root',
    projectId: 'demo',
    name: 'Trace 1',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    runCount: 4,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    schemaVersion: 1,
    traceId: 'trace-1',
    runId: 'root',
    type: 'chain',
    name: 'Run',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
