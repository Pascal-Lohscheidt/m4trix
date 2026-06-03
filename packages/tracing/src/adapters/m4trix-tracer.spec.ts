import { describe, expect, it } from 'vitest';
import { toM4trixTracer } from './m4trix-tracer.js';
import {
  type PayloadStoreAdapter,
  type StructureStoreAdapter,
  type Trace,
  type TraceRun,
  Tracer,
  TraceStore,
} from '../index.js';

describe('toM4trixTracer', () => {
  it('writes root and agent runs to TraceStore', async () => {
    const structureStoreAdapter = new RecordingStructureStoreAdapter();
    const payloadStoreAdapter = new RecordingPayloadStoreAdapter();
    const tracer = Tracer.from(TraceStore.of({ payloadStoreAdapter, structureStoreAdapter }));
    const networkTracer = toM4trixTracer(tracer);

    await networkTracer.onRunStart({ runId: 'root-run', contextId: 'ctx-1' });

    const scope = await networkTracer.onAgentInvokeStart({
      agentId: 'example-agent',
      channel: 'main',
      trigger: {
        name: 'message',
        meta: { runId: 'root-run', contextId: 'ctx-1' },
        payload: { message: 'hello' },
      },
    });

    const llm = scope.startRun('llm', 'gpt-4o', { message: 'hello' });
    await llm.end({ text: 'hi there' });
    await networkTracer.onAgentInvokeEnd(scope);
    await networkTracer.onRunEnd({ runId: 'root-run', contextId: 'ctx-1' });
    await networkTracer.flush();

    expect(structureStoreAdapter.traces.length).toBeGreaterThan(0);
    expect(structureStoreAdapter.batches.length).toBeGreaterThan(0);
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
