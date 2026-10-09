import type { RunNode } from '../types';

export type RunKind = 'llm' | 'tool' | 'chain' | 'other';

/** Coarse run category used for badges and waterfall bar colours. */
export function runKind(type: string): RunKind {
  const normalized = type.toLowerCase().replaceAll(/[\s_-]/g, '');
  if (normalized.includes('tool')) return 'tool';
  if (normalized.includes('chain')) return 'chain';
  if (normalized.includes('llm') || normalized.includes('ai') || normalized.includes('model')) {
    return 'llm';
  }
  return 'other';
}

/** Time window covered by a trace: earliest run start to the latest run end. */
export type TraceTimeline = {
  startMs: number;
  endMs: number;
  spanMs: number;
};

export type RunBar = {
  /** Offset of the run start from the trace start, in percent of the span. */
  leftPct: number;
  /** Bar width in percent of the span (0 for instant runs; the UI applies a minimum width). */
  widthPct: number;
  /** Run start relative to the trace start. */
  offsetMs: number;
  /** Known duration, or the time until the trace's last activity for unfinished runs. */
  durationMs: number;
  /** True when the run has no end yet, so the bar runs to the end of the timeline. */
  open: boolean;
};

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function runEndMs(run: RunNode): number | null {
  const end = parseMs(run.endTime);
  if (end != null) return end;
  const start = parseMs(run.startTime);
  return start != null && run.latencyMs != null ? start + run.latencyMs : null;
}

/**
 * Spans every run, not just the root: children can outlive their parent (clock skew, detached
 * work) and unfinished runs still need room on the axis. Returns null without any parseable start.
 */
export function computeTraceTimeline(root: RunNode): TraceTimeline | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  const visit = (run: RunNode) => {
    const start = parseMs(run.startTime);
    if (start != null) {
      startMs = Math.min(startMs, start);
      endMs = Math.max(endMs, start);
    }
    const end = runEndMs(run);
    if (end != null) endMs = Math.max(endMs, end);
    for (const child of run.children) visit(child);
  };
  visit(root);
  if (!Number.isFinite(startMs)) return null;
  return { startMs, endMs, spanMs: endMs - startMs };
}

/** Bar geometry for one run, clamped to the timeline. Null when the run start is unparseable. */
export function runBar(run: RunNode, timeline: TraceTimeline): RunBar | null {
  const start = parseMs(run.startTime);
  if (start == null) return null;
  const end = runEndMs(run);
  const open = end == null;
  const clampedStart = Math.min(Math.max(start, timeline.startMs), timeline.endMs);
  const clampedEnd = Math.min(Math.max(end ?? timeline.endMs, clampedStart), timeline.endMs);
  const offsetMs = clampedStart - timeline.startMs;
  const durationMs = clampedEnd - clampedStart;
  if (timeline.spanMs <= 0) {
    return { leftPct: 0, widthPct: 100, offsetMs, durationMs, open };
  }
  return {
    leftPct: (offsetMs / timeline.spanMs) * 100,
    widthPct: (durationMs / timeline.spanMs) * 100,
    offsetMs,
    durationMs,
    open,
  };
}

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/**
 * Evenly spaced axis ticks on "nice" millisecond values (1, 2, 2.5, 5 × 10ⁿ), always starting at
 * 0. Aims for roughly `targetCount` intervals across the span.
 */
export function timelineTicks(spanMs: number, targetCount = 4): number[] {
  if (!(spanMs > 0)) return [0];
  const rough = spanMs / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = (NICE_STEPS.find((n) => n * magnitude >= rough) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let tick = 0; tick <= spanMs + step * 1e-9; tick += step) {
    ticks.push(Number(tick.toPrecision(12)));
  }
  return ticks;
}
