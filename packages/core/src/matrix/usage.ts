import type { NetworkLogger } from './logger.js';

/**
 * What one model call (or any other metered step) used, as reported with `reportUsage()`.
 * Provider-agnostic: map your SDK's usage object onto it. Every field is optional.
 */
export type UsageReport = {
  /** Input (prompt) tokens, cache reads and writes included. */
  inputTokens?: number;
  /** Output (completion) tokens, reasoning tokens included. */
  outputTokens?: number;
  /** Total tokens; `inputTokens + outputTokens` when left out. Counted against `maxTokens`. */
  totalTokens?: number;
  /** Input tokens served from the provider's prompt cache (part of `inputTokens`). */
  cacheReadTokens?: number;
  /** Input tokens written to the provider's prompt cache (part of `inputTokens`). */
  cacheWriteTokens?: number;
  /** Cost in USD, if you know it. Counted against `maxCostUsd`. */
  costUsd?: number;
  /** Model that served the call; usage is broken down per model. */
  model?: string;
};

/** Summed usage. Fields nobody reported stay `0`. */
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

/** A run's usage: totals over every report, and per model for reports that named one. */
export type RunUsage = UsageTotals & {
  byModel: Record<string, UsageTotals>;
};

/** Where a usage report came from, beyond the reporting agent. */
export type UsageSource = {
  /** Set when a tool reported it. */
  readonly tool?: { readonly name: string; readonly toolCallId: string };
};

/** Records a usage report; `source` attributes it to a tool. */
export type UsageReporter = (usage: UsageReport, source?: UsageSource) => void;

const numericFields = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
] as const;

const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

/**
 * A copy of `usage` without invalid fields (negative or non-finite numbers, a non-string model),
 * each dropped with a warning: bad telemetry must not poison a run's totals or fail the run.
 */
export function sanitizeUsageReport(
  usage: UsageReport,
  logger: Pick<NetworkLogger, 'warn'>,
): UsageReport {
  const clean: UsageReport = {};
  const dropped: string[] = [];
  for (const field of numericFields) {
    const value = usage[field];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[field] = value;
    else dropped.push(field);
  }
  if (usage.model !== undefined) {
    if (typeof usage.model === 'string') clean.model = usage.model;
    else dropped.push('model');
  }
  if (dropped.length > 0) {
    logger.warn(`[m4trix] reportUsage: ignoring invalid ${dropped.join(', ')}`);
  }
  return clean;
}

function addTotals(totals: UsageTotals, usage: UsageReport): void {
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  totals.costUsd += usage.costUsd ?? 0;
}

/** Adds a (sanitized) report to a run's usage, in place; starts it on the first report. */
export function addUsage(runUsage: RunUsage | undefined, usage: UsageReport): RunUsage {
  const next = runUsage ?? { ...emptyTotals(), byModel: {} };
  addTotals(next, usage);
  if (usage.model !== undefined) {
    const perModel = next.byModel[usage.model] ?? emptyTotals();
    addTotals(perModel, usage);
    next.byModel[usage.model] = perModel;
  }
  return next;
}

/** A copy of `usage` that later reports do not change. */
export function snapshotUsage(usage: RunUsage): RunUsage {
  const byModel: Record<string, UsageTotals> = {};
  for (const [model, totals] of Object.entries(usage.byModel)) byModel[model] = { ...totals };
  return { ...usage, byModel };
}
