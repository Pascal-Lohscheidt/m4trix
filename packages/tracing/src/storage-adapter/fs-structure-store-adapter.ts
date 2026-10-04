import { mkdir, readdir, readFile } from 'node:fs/promises';
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
import { writeFileAtomic } from './atomic-write.js';
import { KeyedMutex } from './keyed-mutex.js';

export type FsStructureStoreAdapterOptions = {
  path: string;
};

/**
 * Every read-modify-write of a trace's files runs under a per-trace lock, so concurrent flushes and
 * annotation edits within one process cannot drop each other's changes. Upserts that omit
 * `annotation` keep the stored one; only an explicit `annotation` or a patch changes it.
 */
export class FsStructureStoreAdapter implements StructureStoreAdapter {
  private readonly rootPath: string;
  private readonly traceLocks = new KeyedMutex();

  constructor(options: FsStructureStoreAdapterOptions) {
    this.rootPath = resolve(options.path);
  }

  async upsertTrace(trace: Trace): Promise<void> {
    await this.traceLocks.run(trace.traceId, async () => {
      const existing = await this.readTrace(trace.traceId);
      await this.writeTrace(keepStoredAnnotation(trace, existing));
    });
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
      await this.traceLocks.run(traceId, async () => {
        const byRunId = new Map((await this.readRuns(traceId)).map((run) => [run.runId, run]));
        for (const run of traceRuns) {
          byRunId.set(run.runId, keepStoredAnnotation(run, byRunId.get(run.runId)));
        }
        await this.writeRuns(traceId, [...byRunId.values()]);
      });
    }
  }

  async getTrace(traceId: string): Promise<TraceRecord | null> {
    const trace = await this.readTrace(traceId);
    if (!trace) return null;
    return { trace, runs: await this.readRuns(traceId) };
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
    return this.traceLocks.run(input.traceId, async () => {
      const existing = await this.readTrace(input.traceId);
      if (!existing) return null;

      const annotation = mergeTraceAnnotation(
        existing.annotation,
        input.annotation,
        input.merge ?? true,
      );
      const trace: Trace = { ...existing, annotation };
      if (annotation === undefined) delete trace.annotation;

      await this.writeTrace(trace);
      return trace;
    });
  }

  async patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null> {
    return this.traceLocks.run(input.traceId, async () => {
      if (!(await this.readTrace(input.traceId))) return null;

      const runs = await this.readRuns(input.traceId);
      const run = runs.find((candidate) => candidate.runId === input.runId);
      if (!run) return null;

      const annotation = mergeTraceAnnotation(
        run.annotation,
        input.annotation,
        input.merge ?? true,
      );
      const updatedRun: TraceRun = { ...run, annotation };
      if (annotation === undefined) delete updatedRun.annotation;

      await this.writeRuns(
        input.traceId,
        runs.map((candidate) => (candidate.runId === run.runId ? updatedRun : candidate)),
      );
      return updatedRun;
    });
  }

  private async readTrace(traceId: string): Promise<Trace | null> {
    try {
      return JSON.parse(await readFile(this.tracePath(traceId), 'utf-8')) as Trace;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeTrace(trace: Trace): Promise<void> {
    const tracePath = this.tracePath(trace.traceId);
    await mkdir(dirname(tracePath), { recursive: true });
    await writeFileAtomic(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  }

  private async writeRuns(traceId: string, runs: TraceRun[]): Promise<void> {
    const runsPath = this.runsPath(traceId);
    await mkdir(dirname(runsPath), { recursive: true });
    await writeFileAtomic(runsPath, `${runs.map((run) => JSON.stringify(run)).join('\n')}\n`);
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

function keepStoredAnnotation<T extends Trace | TraceRun>(
  incoming: T,
  stored: T | null | undefined,
): T {
  if (incoming.annotation !== undefined || stored?.annotation === undefined) return incoming;
  return { ...incoming, annotation: stored.annotation };
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
