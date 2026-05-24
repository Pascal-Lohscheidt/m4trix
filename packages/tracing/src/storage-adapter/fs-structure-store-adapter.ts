import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { mergeTraceAnnotation } from '../annotation-merge.js';
import type {
  ListTracesQuery,
  ListTracesResult,
  PatchRunAnnotationInput,
  PatchTraceAnnotationInput,
  StructureStoreAdapter,
  Trace,
  TraceRecord,
  TraceRun,
} from '../types.js';

export type FsStructureStoreAdapterOptions = {
  path: string;
};

export class FsStructureStoreAdapter implements StructureStoreAdapter {
  private readonly rootPath: string;

  constructor(options: FsStructureStoreAdapterOptions) {
    this.rootPath = resolve(options.path);
  }

  async upsertTrace(trace: Trace): Promise<void> {
    const tracePath = this.tracePath(trace.traceId);
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf-8');
  }

  async upsertRun(run: TraceRun): Promise<void> {
    await this.upsertRunBatch([run]);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    const runsByTraceId = new Map<string, TraceRun[]>();
    for (const run of runs) {
      const traceRuns = runsByTraceId.get(run.traceId) ?? [];
      traceRuns.push(run);
      runsByTraceId.set(run.traceId, traceRuns);
    }

    for (const [traceId, traceRuns] of runsByTraceId) {
      const existingRuns = await this.readRuns(traceId);
      const byRunId = new Map(existingRuns.map((run) => [run.runId, run]));
      for (const run of traceRuns) {
        byRunId.set(run.runId, run);
      }

      const runsPath = this.runsPath(traceId);
      await mkdir(dirname(runsPath), { recursive: true });
      await writeFile(
        runsPath,
        `${[...byRunId.values()].map((run) => JSON.stringify(run)).join('\n')}\n`,
        'utf-8',
      );
    }
  }

  async getTrace(traceId: string): Promise<TraceRecord | null> {
    try {
      const trace = JSON.parse(await readFile(this.tracePath(traceId), 'utf-8')) as Trace;
      return { trace, runs: await this.readRuns(traceId) };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listTraces(query: ListTracesQuery = {}): Promise<ListTracesResult> {
    const traceDirs = await this.readTraceDirs();
    const traces = (
      await Promise.all(
        traceDirs.map(async (traceId) => {
          try {
            return JSON.parse(await readFile(this.tracePath(traceId), 'utf-8')) as Trace;
          } catch (error) {
            if (isNodeError(error) && error.code === 'ENOENT') return null;
            throw error;
          }
        }),
      )
    )
      .filter((trace): trace is Trace => trace !== null)
      .filter((trace) => matchesTraceQuery(trace, query))
      .sort((left, right) => right.startTime.localeCompare(left.startTime));

    const startIndex = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const safeStartIndex = Number.isFinite(startIndex) && startIndex > 0 ? startIndex : 0;
    const limit = query.limit && query.limit > 0 ? query.limit : traces.length;
    const pagedTraces = traces.slice(safeStartIndex, safeStartIndex + limit);
    const nextIndex = safeStartIndex + pagedTraces.length;

    return {
      traces: pagedTraces,
      ...(nextIndex < traces.length ? { nextCursor: String(nextIndex) } : {}),
    };
  }

  async patchTraceAnnotation(input: PatchTraceAnnotationInput): Promise<Trace | null> {
    const record = await this.getTrace(input.traceId);
    if (!record) return null;

    const annotation = mergeTraceAnnotation(
      record.trace.annotation,
      input.annotation,
      input.merge ?? true,
    );
    const trace: Trace = { ...record.trace, annotation };
    if (annotation === undefined) delete trace.annotation;

    await this.upsertTrace(trace);
    return trace;
  }

  async patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null> {
    const record = await this.getTrace(input.traceId);
    if (!record) return null;

    const run = record.runs.find((candidate) => candidate.runId === input.runId);
    if (!run) return null;

    const annotation = mergeTraceAnnotation(run.annotation, input.annotation, input.merge ?? true);
    const updatedRun: TraceRun = { ...run, annotation };
    if (annotation === undefined) delete updatedRun.annotation;

    await this.upsertRun(updatedRun);
    return updatedRun;
  }

  private async readTraceDirs(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.rootPath, 'traces'), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  private async readRuns(traceId: string): Promise<TraceRun[]> {
    try {
      const content = await readFile(this.runsPath(traceId), 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TraceRun);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  private tracePath(traceId: string): string {
    return join(this.rootPath, 'traces', assertSafeSegment(traceId, 'traceId'), 'trace.json');
  }

  private runsPath(traceId: string): string {
    return join(this.rootPath, 'traces', assertSafeSegment(traceId, 'traceId'), 'runs.ndjson');
  }
}

function matchesTraceQuery(trace: Trace, query: ListTracesQuery): boolean {
  if (query.projectId && trace.projectId !== query.projectId) return false;
  if (query.status && trace.status !== query.status) return false;
  if (query.startAfter && trace.startTime <= query.startAfter) return false;
  if (query.startBefore && trace.startTime >= query.startBefore) return false;
  return true;
}

function assertSafeSegment(value: string, label: string): string {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
