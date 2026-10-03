import type { RunNode } from '../../types';
import { type ResolvedView, resolveView } from './extract';
import type { PayloadMapping } from './mapping-schema';
import { type PayloadSide, selectRule } from './match';
import { flattenRuns, groupKeyOf, type SampleGroup } from './sampling';

export type SampleOutcome = 'mapped' | 'partial' | 'fallback' | 'unmatched';

export type SampleEvaluation = {
  outcome: SampleOutcome;
  ruleId: string | null;
  /** Unmatched paths and nested fallback reasons. */
  issues: string[];
};

type RunIdentity = Pick<RunNode, 'type' | 'name' | 'metadata'>;

function collectFallbacks(view: ResolvedView, out: string[]): void {
  if (view.kind === 'fallback') out.push(view.reason);
  else if (view.kind === 'stack') for (const child of view.children) collectFallbacks(child, out);
  else if (view.kind === 'toolResult' && view.body) collectFallbacks(view.body, out);
}

/**
 * - `unmatched`: no rule matched (raw JSON shown)
 * - `fallback`: a rule matched but its top-level view could not resolve
 * - `partial`: rendered, but some configured paths missed or a nested block fell back
 * - `mapped`: rendered cleanly
 */
export function evaluateSample(
  mapping: PayloadMapping,
  run: RunIdentity,
  side: PayloadSide,
  payload: unknown,
): SampleEvaluation {
  const rule = selectRule(mapping, { run, side, payload });
  if (!rule) return { outcome: 'unmatched', ruleId: null, issues: [] };
  const { view, issues } = resolveView(rule.view, payload);
  if (view.kind === 'fallback')
    return { outcome: 'fallback', ruleId: rule.id, issues: [view.reason, ...issues] };
  const nested: string[] = [];
  collectFallbacks(view, nested);
  const all = [...new Set([...issues, ...nested])];
  return { outcome: all.length > 0 ? 'partial' : 'mapped', ruleId: rule.id, issues: all };
}

export type GroupCoverage = {
  key: string;
  runType: string;
  runName: string;
  side: PayloadSide;
  total: number;
  mapped: number;
  partial: number;
  fallback: number;
  unmatched: number;
  ruleIds: string[];
  issues: string[];
};

export type CoverageReport = {
  groups: GroupCoverage[];
  total: number;
  mapped: number;
  partial: number;
  fallback: number;
  unmatched: number;
  /** 0..1 — mapped counts fully, partial counts half. */
  score: number;
};

export type CoverageItem = { run: RunIdentity; side: PayloadSide; payload: unknown };

const MAX_ISSUES_PER_GROUP = 5;

export function computeCoverage(mapping: PayloadMapping, items: CoverageItem[]): CoverageReport {
  const byKey = new Map<string, GroupCoverage>();
  for (const item of items) {
    const key = groupKeyOf(item.run, item.side);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        runType: item.run.type,
        runName: item.run.name,
        side: item.side,
        total: 0,
        mapped: 0,
        partial: 0,
        fallback: 0,
        unmatched: 0,
        ruleIds: [],
        issues: [],
      };
      byKey.set(key, g);
    }
    const result = evaluateSample(mapping, item.run, item.side, item.payload);
    g.total++;
    g[result.outcome]++;
    if (result.ruleId && !g.ruleIds.includes(result.ruleId)) g.ruleIds.push(result.ruleId);
    for (const issue of result.issues) {
      if (g.issues.length < MAX_ISSUES_PER_GROUP && !g.issues.includes(issue)) g.issues.push(issue);
    }
  }
  const groups = [...byKey.values()].sort(
    (a, b) => b.unmatched + b.fallback - (a.unmatched + a.fallback) || b.total - a.total,
  );
  const sum = (k: SampleOutcome) => groups.reduce((n, g) => n + g[k], 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const mapped = sum('mapped');
  const partial = sum('partial');
  return {
    groups,
    total,
    mapped,
    partial,
    fallback: sum('fallback'),
    unmatched: sum('unmatched'),
    score: total === 0 ? 0 : (mapped + partial * 0.5) / total,
  };
}

/** Coverage over every run payload of a trace that is already loaded. */
export function coverageForTree(
  mapping: PayloadMapping,
  root: RunNode,
  payloadCache: Record<string, unknown>,
): CoverageReport {
  const items: CoverageItem[] = [];
  for (const run of flattenRuns(root)) {
    for (const side of ['input', 'output'] as const) {
      const ref = side === 'input' ? run.inputRef : run.outputRef;
      if (ref && payloadCache[ref] !== undefined)
        items.push({ run, side, payload: payloadCache[ref] });
    }
  }
  return computeCoverage(mapping, items);
}

/** Coverage over sampled payloads (full originals, not the truncated copies). */
export function coverageForSamples(mapping: PayloadMapping, groups: SampleGroup[]): CoverageReport {
  return computeCoverage(
    mapping,
    groups.flatMap((g) =>
      g.samples.map((s) => ({
        run: { type: g.runType, name: g.runName, metadata: s.runMetadata },
        side: g.side,
        payload: s.original,
      })),
    ),
  );
}

export function formatCoveragePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
