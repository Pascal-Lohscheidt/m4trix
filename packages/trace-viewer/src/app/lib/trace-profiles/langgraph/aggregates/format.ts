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
  if (rollup.costUsd > 0) parts.push(`Reported cost: $${rollup.costUsd.toFixed(6)}`);
  return parts.join(' · ');
}
