import { TraceStore } from '../trace-store.js';
import type {
  PatchRunAnnotationInput,
  PatchTraceAnnotationInput,
  PayloadStoreAdapter,
  StructureStoreAdapter,
  Trace,
  TraceRecord,
  TraceRun,
} from '../types.js';

/** In-memory structure store for specs: records every write and can fail or slow them down. */
export class RecordingStructureStoreAdapter implements StructureStoreAdapter {
  readonly traces: Trace[] = [];
  readonly batches: TraceRun[][] = [];
  writeDelayMs = 0;
  failNextWrites = 0;
  /** Fail every write while set. */
  unavailable = false;
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
    await this.upsertRunBatch([run]);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    await this.write(() => {
      this.batches.push(runs);
      for (const run of runs) this.runRecords.set(run.runId, run);
    });
  }

  /** The latest stored version of a run. */
  run(runId: string): TraceRun | undefined {
    return this.runRecords.get(runId);
  }

  /** The latest stored version of a trace. */
  trace(traceId: string): Trace | undefined {
    return this.traceRecords.get(traceId);
  }

  async getTrace(traceId: string): Promise<TraceRecord | null> {
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

  async patchTraceAnnotation(input: PatchTraceAnnotationInput): Promise<Trace | null> {
    const trace = this.traceRecords.get(input.traceId);
    if (!trace) return null;
    const updated = { ...trace, annotation: { ...trace.annotation, ...input.annotation } };
    this.traceRecords.set(input.traceId, updated);
    return updated;
  }

  async patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null> {
    const run = this.runRecords.get(input.runId);
    if (!run) return null;
    const updated = { ...run, annotation: { ...run.annotation, ...input.annotation } };
    this.runRecords.set(input.runId, updated);
    return updated;
  }

  private async write(apply: () => void): Promise<void> {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (this.writeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
      }
      if (this.unavailable || this.failNextWrites > 0) {
        if (this.failNextWrites > 0) this.failNextWrites -= 1;
        throw new Error('structure store unavailable');
      }
      apply();
    } finally {
      this.activeWrites -= 1;
    }
  }
}

/** In-memory payload store for specs. */
export class RecordingPayloadStoreAdapter implements PayloadStoreAdapter {
  readonly payloads = new Map<string, unknown>();
  /** Fail every write while set. */
  unavailable = false;

  async putJson(path: string, value: unknown): Promise<string> {
    if (this.unavailable) throw new Error('payload store unavailable');
    // Store what a real adapter would: the JSON round trip.
    this.payloads.set(path, JSON.parse(JSON.stringify(value) ?? 'null'));
    return path;
  }

  async getJson<T = unknown>(ref: string): Promise<T> {
    if (!this.payloads.has(ref)) throw new Error(`No payload at ${ref}`);
    return this.payloads.get(ref) as T;
  }
}

export function recordingTraceStore(): {
  traceStore: TraceStore;
  structure: RecordingStructureStoreAdapter;
  payloads: RecordingPayloadStoreAdapter;
} {
  const structure = new RecordingStructureStoreAdapter();
  const payloads = new RecordingPayloadStoreAdapter();
  return {
    traceStore: TraceStore.of({ structureStoreAdapter: structure, payloadStoreAdapter: payloads }),
    structure,
    payloads,
  };
}
