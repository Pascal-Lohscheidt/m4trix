import type { RunNode } from '../../../../types';
import { applyEstimatedCostForRun } from './estimate-cost';
import { extractMetadataUsage } from './extract-metadata';
import { extractUsageFromUnknown } from './extract-usage';
import { addUsageToRollup } from './rollup';
import type { RunSubtreeRollup } from './types';
import { emptySubtreeRollup, finalizeTokenRollup, syncRollupCostTotal } from './utils';

function applyExtractedUsage(rollup: RunSubtreeRollup, extracted: ReturnType<typeof extractUsageFromUnknown>): void {
  if (
    extracted.promptTokens != null ||
    extracted.completionTokens != null ||
    extracted.totalTokens != null
  ) {
    rollup.hasUsage = true;
    addUsageToRollup(rollup, {
      promptTokens: extracted.promptTokens ?? 0,
      completionTokens: extracted.completionTokens ?? 0,
      totalTokens: extracted.totalTokens ?? 0,
    });
  }
  if (extracted.costUsd != null) {
    rollup.costUsdReported += extracted.costUsd;
    rollup.hasUsage = true;
  }
}

/** Token/cost usage reported on this run only (not descendants). */
export function directUsageForRun(
  node: RunNode,
  payloadCache: Record<string, unknown>,
): RunSubtreeRollup {
  const rollup = emptySubtreeRollup();

  if (node.tokens) {
    const input = node.tokens.input ?? 0;
    const output = node.tokens.output ?? 0;
    if (input > 0 || output > 0) {
      rollup.hasUsage = true;
      addUsageToRollup(rollup, {
        promptTokens: input,
        completionTokens: output,
        totalTokens: input + output,
      });
    }
  }
  if (node.costUsd != null && node.costUsd > 0) {
    rollup.costUsdReported += node.costUsd;
    rollup.hasUsage = true;
  }

  const fromMeta = extractMetadataUsage(node.metadata);
  if (fromMeta.tokens) {
    const u = fromMeta.tokens;
    if (u.promptTokens != null || u.completionTokens != null || u.totalTokens != null) {
      rollup.hasUsage = true;
      addUsageToRollup(rollup, {
        promptTokens: u.promptTokens ?? 0,
        completionTokens: u.completionTokens ?? 0,
        totalTokens: u.totalTokens ?? 0,
      });
    }
  }
  if (fromMeta.costUsd != null) {
    rollup.costUsdReported += fromMeta.costUsd;
    rollup.hasUsage = true;
  }

  for (const ref of [node.inputRef, node.outputRef]) {
    if (!ref || payloadCache[ref] === undefined) continue;
    applyExtractedUsage(rollup, extractUsageFromUnknown(payloadCache[ref]));
  }

  finalizeTokenRollup(rollup);
  applyEstimatedCostForRun(rollup, node, payloadCache);
  syncRollupCostTotal(rollup);
  return rollup;
}
