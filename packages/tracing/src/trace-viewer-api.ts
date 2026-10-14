import { readScores, type ScoreInput, type TraceScore } from './scores.js';
import type { TraceStore } from './trace-store.js';
import type {
  ListTracesQuery,
  ListTracesResult,
  PatchRunAnnotationInput,
  PatchTraceAnnotationInput,
  Trace,
  TraceMetadata,
  TraceRecord,
  TraceRun,
  TraceRunNode,
} from './types.js';

/** A trace's top-level input and output, ready to become an evaluation test case. */
export type TraceExample = {
  traceId: string;
  name: string;
  input: unknown;
  output?: unknown;
  status: Trace['status'];
  tags?: string[];
  metadata?: TraceMetadata;
  scores: Record<string, TraceScore>;
};

export class TraceViewerApi {
  private constructor(private readonly traceStore: TraceStore) {}

  static from(traceStore: TraceStore): TraceViewerApi {
    return new TraceViewerApi(traceStore);
  }

  listTraces(query?: ListTracesQuery): Promise<ListTracesResult> {
    return this.traceStore.listTraces(query);
  }

  getTrace(traceId: string): Promise<TraceRecord | null> {
    return this.traceStore.getTrace(traceId);
  }

  async getTraceTree(traceId: string): Promise<{ trace: Trace; root: TraceRunNode } | null> {
    const record = await this.traceStore.getTrace(traceId);
    if (!record) return null;

    const nodes = new Map<string, TraceRunNode>();
    for (const run of record.runs) {
      nodes.set(run.runId, { ...run, children: [] });
    }

    for (const node of nodes.values()) {
      if (!node.parentRunId) continue;

      const parent = nodes.get(node.parentRunId);
      if (parent) parent.children.push(node);
    }

    for (const node of nodes.values()) {
      node.children.sort(compareRunsByStartTime);
    }

    const root = nodes.get(record.trace.rootRunId);
    if (!root || root.parentRunId) return null;

    return { trace: record.trace, root };
  }

  getPayload<T = unknown>(ref: string): Promise<T> {
    return this.traceStore.getPayload<T>(ref);
  }

  /** The root run's input and output, e.g. to turn a production trace into a test case. */
  async getTraceExample(traceId: string): Promise<TraceExample | null> {
    const record = await this.traceStore.getTrace(traceId);
    const root = record?.runs.find((run) => run.runId === record.trace.rootRunId);
    if (!record || !root) return null;

    const [input, output] = await Promise.all([
      root.inputRef ? this.traceStore.getPayload(root.inputRef) : undefined,
      root.outputRef ? this.traceStore.getPayload(root.outputRef) : undefined,
    ]);
    const { trace } = record;
    return {
      traceId,
      name: trace.name,
      input,
      ...(output !== undefined ? { output } : {}),
      status: trace.status,
      ...(trace.tags ? { tags: trace.tags } : {}),
      ...(trace.metadata ? { metadata: trace.metadata } : {}),
      scores: readScores(trace.annotation),
    };
  }

  score(input: ScoreInput): Promise<TraceScore | null> {
    return this.traceStore.score(input);
  }

  patchTraceAnnotation(input: PatchTraceAnnotationInput): Promise<Trace | null> {
    return this.traceStore.patchTraceAnnotation(input);
  }

  patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null> {
    return this.traceStore.patchRunAnnotation(input);
  }
}

function compareRunsByStartTime(left: TraceRun, right: TraceRun): number {
  return left.startTime.localeCompare(right.startTime) || left.runId.localeCompare(right.runId);
}
