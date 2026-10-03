import { describe, expect, it, vi } from 'vitest';
import { testRun } from '../trace-profiles/langgraph/aggregates/test-helpers';
import { collectSampleGroups } from './collect';

const treeFor = (traceId: string) => ({
  root: testRun({
    runId: `${traceId}-root`,
    name: 'graph',
    type: 'chain',
    children: [
      testRun({
        runId: `${traceId}-llm`,
        name: 'llm',
        type: 'chat_model',
        outputRef: `${traceId}-out`,
      }),
    ],
  }),
});

describe('collectSampleGroups', () => {
  it('loads trees and payloads, reusing known ones, and reports progress', async () => {
    const getTree = vi.fn(async (id: string) => (id === 'missing' ? null : treeFor(id)));
    const getPayload = vi.fn(async (ref: string) => {
      if (ref === 't3-out') throw new Error('boom');
      return { ref };
    });
    const progress: string[] = [];
    const result = await collectSampleGroups({
      traceIds: ['t1', 't2', 't3', 'missing'],
      deps: { getTree, getPayload },
      knownTrees: { t1: treeFor('t1') },
      knownPayloads: { 't1-out': { cached: true } },
      onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`),
    });

    expect(getTree.mock.calls.map((c) => c[0]).sort()).toEqual(['missing', 't2', 't3']);
    expect(getPayload.mock.calls.map((c) => c[0]).sort()).toEqual(['t2-out', 't3-out']);
    expect(result).toMatchObject({ scannedTraces: 3, failedPayloads: 1 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ key: 'chat_model · llm · output', runCount: 3 });
    expect(result.groups[0].samples.map((s) => s.original)).toEqual([
      { cached: true },
      { ref: 't2-out' },
    ]);
    expect(progress).toContain('trees:4/4');
    expect(progress).toContain('payloads:3/3');
  });

  it('includes pinned refs and stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectSampleGroups({
        traceIds: ['t1'],
        deps: { getTree: async (id) => treeFor(id), getPayload: async () => ({}) },
        signal: controller.signal,
      }),
    ).rejects.toThrow('Aborted');

    const result = await collectSampleGroups({
      traceIds: ['t1', 't2', 't3', 't4'],
      perGroup: 1,
      pinnedRefs: ['t3-out'],
      deps: { getTree: async (id) => treeFor(id), getPayload: async (ref) => ({ ref }) },
    });
    expect(result.groups[0].samples.map((s) => s.ref)).toEqual(['t3-out']);
  });
});
