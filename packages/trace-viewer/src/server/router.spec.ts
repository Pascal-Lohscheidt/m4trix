import type { TraceViewerApi } from '@m4trix/tracing';
import { describe, expect, it, vi } from 'vitest';
import { appRouter } from './router';

describe('appRouter', () => {
  it('delegates traces.list to TraceViewerApi', async () => {
    const listTraces = vi.fn(async () => ({ traces: [] }));
    const traceViewerApi = {
      listTraces,
      getTraceTree: vi.fn(),
      getPayload: vi.fn(),
    } as unknown as TraceViewerApi;

    const caller = appRouter.createCaller({ traceViewerApi });
    await expect(caller.traces.list({ limit: 5, projectId: 'p' })).resolves.toEqual({ traces: [] });
    expect(listTraces).toHaveBeenCalledWith({ limit: 5, projectId: 'p' });
  });

  it('delegates traces.getTree', async () => {
    const getTraceTree = vi.fn(async () => null);
    const traceViewerApi = {
      listTraces: vi.fn(),
      getTraceTree,
      getPayload: vi.fn(),
    } as unknown as TraceViewerApi;

    const caller = appRouter.createCaller({ traceViewerApi });
    await expect(caller.traces.getTree({ traceId: 't1' })).resolves.toBeNull();
    expect(getTraceTree).toHaveBeenCalledWith('t1');
  });

  it('delegates traces.getPayload', async () => {
    const getPayload = vi.fn(async () => ({ ok: true }));
    const traceViewerApi = {
      listTraces: vi.fn(),
      getTraceTree: vi.fn(),
      getPayload,
      patchTraceAnnotation: vi.fn(),
      patchRunAnnotation: vi.fn(),
    } as unknown as TraceViewerApi;

    const caller = appRouter.createCaller({ traceViewerApi });
    await expect(caller.traces.getPayload({ ref: 'payload.json' })).resolves.toEqual({ ok: true });
    expect(getPayload).toHaveBeenCalledWith('payload.json');
  });

  it('delegates traces.patchAnnotation', async () => {
    const patchTraceAnnotation = vi.fn(async () => ({ traceId: 't1', annotation: { label: 'x' } }));
    const traceViewerApi = {
      listTraces: vi.fn(),
      getTraceTree: vi.fn(),
      getPayload: vi.fn(),
      patchTraceAnnotation,
      patchRunAnnotation: vi.fn(),
    } as unknown as TraceViewerApi;

    const caller = appRouter.createCaller({ traceViewerApi });
    await expect(
      caller.traces.patchAnnotation({ traceId: 't1', annotation: { label: 'x' } }),
    ).resolves.toEqual({ traceId: 't1', annotation: { label: 'x' } });
    expect(patchTraceAnnotation).toHaveBeenCalledWith({ traceId: 't1', annotation: { label: 'x' } });
  });

  it('delegates traces.patchRunAnnotation', async () => {
    const patchRunAnnotation = vi.fn(async () => ({ runId: 'r1', annotation: { note: 'y' } }));
    const traceViewerApi = {
      listTraces: vi.fn(),
      getTraceTree: vi.fn(),
      getPayload: vi.fn(),
      patchTraceAnnotation: vi.fn(),
      patchRunAnnotation,
    } as unknown as TraceViewerApi;

    const caller = appRouter.createCaller({ traceViewerApi });
    await expect(
      caller.traces.patchRunAnnotation({
        traceId: 't1',
        runId: 'r1',
        annotation: { note: 'y' },
      }),
    ).resolves.toEqual({ runId: 'r1', annotation: { note: 'y' } });
    expect(patchRunAnnotation).toHaveBeenCalledWith({
      traceId: 't1',
      runId: 'r1',
      annotation: { note: 'y' },
    });
  });
});
