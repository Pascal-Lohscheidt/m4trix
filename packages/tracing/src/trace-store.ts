import type {
  ListTracesQuery,
  PatchRunAnnotationInput,
  PatchTraceAnnotationInput,
  PayloadStoreAdapter,
  StructureStoreAdapter,
  Trace,
  TraceRun,
} from './types.js';

export type TraceStoreOptions = {
  structureStoreAdapter: StructureStoreAdapter;
  payloadStoreAdapter: PayloadStoreAdapter;
};

export class TraceStore {
  readonly structureStoreAdapter: StructureStoreAdapter;
  readonly payloadStoreAdapter: PayloadStoreAdapter;

  private constructor(options: TraceStoreOptions) {
    this.structureStoreAdapter = options.structureStoreAdapter;
    this.payloadStoreAdapter = options.payloadStoreAdapter;
  }

  static of(options: TraceStoreOptions): TraceStore {
    return new TraceStore(options);
  }

  upsertTrace(trace: Trace): Promise<void> {
    return this.structureStoreAdapter.upsertTrace(trace);
  }

  upsertRun(run: TraceRun): Promise<void> {
    return this.structureStoreAdapter.upsertRun(run);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    if (runs.length === 0) return;

    if (this.structureStoreAdapter.upsertRunBatch) {
      await this.structureStoreAdapter.upsertRunBatch(runs);
      return;
    }

    for (const run of runs) {
      await this.upsertRun(run);
    }
  }

  getTrace(traceId: string): Promise<{ trace: Trace; runs: TraceRun[] } | null> {
    return this.structureStoreAdapter.getTrace(traceId);
  }

  listTraces(query?: ListTracesQuery): Promise<{ traces: Trace[]; nextCursor?: string }> {
    return this.structureStoreAdapter.listTraces(query);
  }

  patchTraceAnnotation(input: PatchTraceAnnotationInput): Promise<Trace | null> {
    return this.structureStoreAdapter.patchTraceAnnotation(input);
  }

  patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null> {
    return this.structureStoreAdapter.patchRunAnnotation(input);
  }

  putJsonPayload(path: string, value: unknown): Promise<string> {
    return this.payloadStoreAdapter.putJson(path, value);
  }

  getPayload<T = unknown>(ref: string): Promise<T> {
    return this.payloadStoreAdapter.getJson<T>(ref);
  }

  putPayloadStream(
    path: string,
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<string> {
    if (!this.payloadStoreAdapter.putStream) {
      throw new Error('Payload store adapter does not support streams.');
    }

    return this.payloadStoreAdapter.putStream(path, body);
  }

  getPayloadStream(ref: string): Promise<ReadableStream<Uint8Array>> {
    if (!this.payloadStoreAdapter.getStream) {
      throw new Error('Payload store adapter does not support streams.');
    }

    return this.payloadStoreAdapter.getStream(ref);
  }
}
