import { describe, expect, it } from 'vitest';
import type { RunNode } from '../types';
import { computeTraceTimeline, runBar, runKind, timelineTicks } from './waterfall';

const T0 = Date.parse('2026-05-09T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function run(
  runId: string,
  startMs: number,
  endMs: number | null,
  children: RunNode[] = [],
  extra: Partial<RunNode> = {},
): RunNode {
  return {
    runId,
    name: runId,
    type: 'chain',
    status: endMs == null ? 'running' : 'success',
    startTime: at(startMs),
    endTime: endMs == null ? undefined : at(endMs),
    children,
    ...extra,
  };
}

describe('runKind', () => {
  it('classifies common run types', () => {
    expect(runKind('tool')).toBe('tool');
    expect(runKind('chain')).toBe('chain');
    expect(runKind('llm')).toBe('llm');
    expect(runKind('chat_model')).toBe('llm');
    expect(runKind('retriever')).toBe('other');
  });
});

describe('computeTraceTimeline', () => {
  it('spans the earliest start to the latest end across all runs', () => {
    const root = run('root', 0, 50, [run('a', 10, 30), run('late', 40, 80)]);
    expect(computeTraceTimeline(root)).toEqual({ startMs: T0, endMs: T0 + 80, spanMs: 80 });
  });

  it('uses latencyMs when endTime is missing', () => {
    const root = run('root', 0, null, [], { latencyMs: 120 });
    expect(computeTraceTimeline(root)?.spanMs).toBe(120);
  });

  it('extends to the latest start when runs are unfinished', () => {
    const root = run('root', 0, null, [run('a', 5, 20), run('open', 35, null)]);
    expect(computeTraceTimeline(root)?.spanMs).toBe(35);
  });

  it('returns null without any parseable start time', () => {
    const root = run('root', 0, 10, [], { startTime: 'not-a-date' });
    root.endTime = undefined;
    expect(computeTraceTimeline(root)).toBeNull();
  });
});

describe('runBar', () => {
  const root = run('root', 0, 100, [run('mid', 25, 75), run('open', 60, null)]);
  const timeline = computeTraceTimeline(root);
  if (!timeline) throw new Error('fixture timeline');

  it('positions a finished run as a share of the span', () => {
    expect(runBar(root.children[0], timeline)).toEqual({
      leftPct: 25,
      widthPct: 50,
      offsetMs: 25,
      durationMs: 50,
      open: false,
    });
  });

  it('runs an unfinished bar to the end of the timeline', () => {
    const bar = runBar(root.children[1], timeline);
    expect(bar).toMatchObject({ leftPct: 60, widthPct: 40, open: true });
  });

  it('clamps runs that start before or end after the timeline', () => {
    const skewed = run('skewed', -20, 140);
    expect(runBar(skewed, timeline)).toMatchObject({ leftPct: 0, widthPct: 100, offsetMs: 0 });
  });

  it('fills the track for a zero-length trace', () => {
    const instant = run('instant', 0, 0);
    const flat = computeTraceTimeline(instant);
    if (!flat) throw new Error('fixture timeline');
    expect(runBar(instant, flat)).toMatchObject({ leftPct: 0, widthPct: 100, durationMs: 0 });
  });

  it('returns null for an unparseable start', () => {
    expect(runBar(run('bad', 0, 10, [], { startTime: 'nope' }), timeline)).toBeNull();
  });
});

describe('timelineTicks', () => {
  it('picks nice steps starting at zero', () => {
    expect(timelineTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(timelineTicks(55)).toEqual([0, 20, 40]);
    expect(timelineTicks(4000)).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('handles sub-millisecond steps without float noise', () => {
    expect(timelineTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('returns a single tick for empty spans', () => {
    expect(timelineTicks(0)).toEqual([0]);
    expect(timelineTicks(Number.NaN)).toEqual([0]);
  });
});
