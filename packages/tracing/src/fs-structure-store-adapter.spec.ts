import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsStructureStoreAdapter, type Trace, type TraceRun } from './index.js';

describe('FsStructureStoreAdapter', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-tracing-structure-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('upserts traces and runs, replacing existing records by id', async () => {
    const adapter = new FsStructureStoreAdapter({ path: root });
    const trace = makeTrace({ status: 'running' });
    const firstRun = makeRun({ status: 'running' });
    const completedRun = makeRun({ status: 'success', endTime: '2026-01-01T00:00:01.000Z' });

    await adapter.upsertTrace(trace);
    await adapter.upsertRun(firstRun);
    await adapter.upsertRun(completedRun);
    await adapter.upsertTrace({ ...trace, status: 'success', endTime: '2026-01-01T00:00:01.000Z' });

    await expect(adapter.getTrace('trace-1')).resolves.toEqual({
      trace: { ...trace, status: 'success', endTime: '2026-01-01T00:00:01.000Z' },
      runs: [completedRun],
    });
  });

  it('lists traces with filters, cursor pagination, and newest-first ordering', async () => {
    const adapter = new FsStructureStoreAdapter({ path: root });

    await adapter.upsertTrace(
      makeTrace({ traceId: 'older', projectId: 'demo', startTime: '2026-01-01T00:00:00.000Z' }),
    );
    await adapter.upsertTrace(
      makeTrace({
        traceId: 'newer-success',
        projectId: 'demo',
        status: 'success',
        startTime: '2026-01-03T00:00:00.000Z',
      }),
    );
    await adapter.upsertTrace(
      makeTrace({
        traceId: 'newer-error',
        projectId: 'demo',
        status: 'error',
        startTime: '2026-01-02T00:00:00.000Z',
      }),
    );

    await expect(adapter.listTraces({ projectId: 'demo', limit: 2 })).resolves.toEqual({
      traces: [
        expect.objectContaining({ traceId: 'newer-success' }),
        expect.objectContaining({ traceId: 'newer-error' }),
      ],
      nextCursor: '2',
    });

    await expect(adapter.listTraces({ projectId: 'demo', cursor: '2', limit: 2 })).resolves.toEqual({
      traces: [expect.objectContaining({ traceId: 'older' })],
    });

    await expect(adapter.listTraces({ projectId: 'demo', status: 'success' })).resolves.toEqual({
      traces: [expect.objectContaining({ traceId: 'newer-success' })],
    });
  });

  it('returns null for missing traces', async () => {
    const adapter = new FsStructureStoreAdapter({ path: root });

    await expect(adapter.getTrace('missing')).resolves.toBeNull();
  });

  it('patches trace and run annotations with deep merge by default', async () => {
    const adapter = new FsStructureStoreAdapter({ path: root });
    const trace = makeTrace({ annotation: { review: { status: 'open' } } });
    const run = makeRun({ annotation: { note: 'first' } });

    await adapter.upsertTrace(trace);
    await adapter.upsertRun(run);

    await expect(
      adapter.patchTraceAnnotation({
        traceId: 'trace-1',
        annotation: { review: { author: 'pascal' }, label: 'bug' },
      }),
    ).resolves.toEqual({
      ...trace,
      annotation: { review: { status: 'open', author: 'pascal' }, label: 'bug' },
    });

    await expect(
      adapter.patchRunAnnotation({
        traceId: 'trace-1',
        runId: 'run-1',
        annotation: { note: 'updated', severity: 'high' },
      }),
    ).resolves.toEqual({
      ...run,
      annotation: { note: 'updated', severity: 'high' },
    });
  });

  it('replaces or clears annotations when merge is false', async () => {
    const adapter = new FsStructureStoreAdapter({ path: root });
    await adapter.upsertTrace(makeTrace({ annotation: { a: 1, b: 2 } }));
    await adapter.upsertRun(makeRun({ annotation: { x: 1 } }));

    await expect(
      adapter.patchTraceAnnotation({
        traceId: 'trace-1',
        annotation: { c: 3 },
        merge: false,
      }),
    ).resolves.toEqual(expect.objectContaining({ annotation: { c: 3 } }));

    await expect(
      adapter.patchRunAnnotation({
        traceId: 'trace-1',
        runId: 'run-1',
        annotation: {},
        merge: false,
      }),
    ).resolves.toEqual(expect.not.objectContaining({ annotation: expect.anything() }));
  });

  it('returns null when patching missing trace or run', async () => {
    const adapter = new FsStructureStoreAdapter({ path: root });
    await adapter.upsertTrace(makeTrace());

    await expect(
      adapter.patchTraceAnnotation({ traceId: 'missing', annotation: { a: 1 } }),
    ).resolves.toBeNull();
    await expect(
      adapter.patchRunAnnotation({ traceId: 'trace-1', runId: 'missing', annotation: { a: 1 } }),
    ).resolves.toBeNull();
  });
});

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
