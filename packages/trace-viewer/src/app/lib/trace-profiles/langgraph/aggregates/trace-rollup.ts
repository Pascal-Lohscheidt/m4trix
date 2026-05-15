import type { RunNode } from '../../../../types';
import { directUsageForRun } from './direct-usage';
import { buildSubtreeRollupsByRunId } from './subtree-rollups';
import type { TokenRollup } from './types';
import { emptySubtreeRollup } from './utils';

export function rollupTraceForLanggraph(
  root: RunNode,
  payloadCache: Record<string, unknown>,
): {
  rollup: TokenRollup;
  costUsdReported: number;
  costUsdEstimated: number;
  spansWithUsage: number;
} {
  const byRunId = buildSubtreeRollupsByRunId(root, payloadCache);
  const rootRollup = byRunId.get(root.runId) ?? emptySubtreeRollup();
  let spansWithUsage = 0;

  const countSpans = (node: RunNode) => {
    if (directUsageForRun(node, payloadCache).hasUsage) spansWithUsage += 1;
    for (const child of node.children) countSpans(child);
  };
  countSpans(root);

  return {
    rollup: {
      promptTokens: rootRollup.promptTokens,
      completionTokens: rootRollup.completionTokens,
      totalTokens: rootRollup.totalTokens,
    },
    costUsdReported: rootRollup.costUsdReported,
    costUsdEstimated: rootRollup.costUsdEstimated,
    spansWithUsage,
  };
}
