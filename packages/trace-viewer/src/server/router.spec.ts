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
    } as unknown as TraceViewerApi;

    const caller = appRouter.createCaller({ traceViewerApi });
    await expect(caller.traces.getPayload({ ref: 'payload.json' })).resolves.toEqual({ ok: true });
    expect(getPayload).toHaveBeenCalledWith('payload.json');
  });
});
