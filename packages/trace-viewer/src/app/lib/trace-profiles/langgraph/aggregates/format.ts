import type { RunSubtreeRollup } from './types';
import { formatTokenCount } from './utils';

export function subtreeRollupTotalTokens(rollup: RunSubtreeRollup): number {
  return rollup.totalTokens > 0
    ? rollup.totalTokens
    : rollup.promptTokens + rollup.completionTokens;
}

/** Compact numeric label for token subtree badges (no unit suffix). */
export function formatSubtreeTokenCount(rollup: RunSubtreeRollup): string | null {
  const total = subtreeRollupTotalTokens(rollup);
  if (total <= 0) return null;
  return formatTokenCount(total);
}

export function formatSubtreeRollupTitle(rollup: RunSubtreeRollup): string {
  const parts: string[] = ['Subtree total (this run + descendants)'];
  const total = subtreeRollupTotalTokens(rollup);
  if (total > 0) parts.push(`Tokens: ${formatTokenCount(total)}`);
  if (rollup.promptTokens > 0) parts.push(`Prompt: ${formatTokenCount(rollup.promptTokens)}`);
  if (rollup.completionTokens > 0)
    parts.push(`Completion: ${formatTokenCount(rollup.completionTokens)}`);
  if (rollup.costUsdReported > 0) {
    parts.push(`Reported cost: $${rollup.costUsdReported.toFixed(6)}`);
  }
  if (rollup.costUsdEstimated > 0) {
    const modelHint = rollup.estimatedModel ? ` (${rollup.estimatedModel})` : '';
    parts.push(`Estimated cost: ~$${rollup.costUsdEstimated.toFixed(6)}${modelHint}`);
  }
  return parts.join(' · ');
}

/** Short cost suffix for run-tree badges when tokens are also shown. */
export function formatSubtreeCostSuffix(rollup: RunSubtreeRollup): string | null {
  if (rollup.costUsd <= 0) return null;
  const prefix = rollup.costUsdEstimated > 0 && rollup.costUsdReported === 0 ? '~' : '';
  return `${prefix}$${rollup.costUsd < 0.01 ? rollup.costUsd.toFixed(4) : rollup.costUsd.toFixed(3)}`;
}
