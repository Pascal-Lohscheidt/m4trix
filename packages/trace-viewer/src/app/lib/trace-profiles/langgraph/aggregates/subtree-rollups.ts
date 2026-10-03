import type { RunNode } from '../../../../types';
import { directUsageForRun } from './direct-usage';
import { addUsageToRollup } from './rollup';
import type { DirectUsageFn, RunSubtreeRollup } from './types';
import { finalizeTokenRollup, syncRollupCostTotal } from './utils';

/**
 * Per-run subtree totals: this run's direct usage plus all descendants.
 * Keys match `runId` on the original trace tree (use the same tree you pass in).
 */
export function buildSubtreeRollupsByRunId(
  root: RunNode,
  payloadCache: Record<string, unknown>,
  directUsage: DirectUsageFn = directUsageForRun,
): Map<string, RunSubtreeRollup> {
  const byRunId = new Map<string, RunSubtreeRollup>();

  const visit = (node: RunNode): RunSubtreeRollup => {
    const subtree = directUsage(node, payloadCache);

    for (const child of node.children) {
      const childSubtree = visit(child);
      addUsageToRollup(subtree, childSubtree);
      subtree.costUsdReported += childSubtree.costUsdReported;
      subtree.costUsdEstimated += childSubtree.costUsdEstimated;
      subtree.hasUsage = subtree.hasUsage || childSubtree.hasUsage;
    }

    finalizeTokenRollup(subtree);
    syncRollupCostTotal(subtree);
    byRunId.set(node.runId, { ...subtree });
    return subtree;
  };

  visit(root);
  return byRunId;
}
