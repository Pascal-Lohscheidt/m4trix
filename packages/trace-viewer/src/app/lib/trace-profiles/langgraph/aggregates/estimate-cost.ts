import type { RunNode } from '../../../../types';
import {
  estimateCostUsdFromPricing,
  lookupPricingKey,
  MODEL_PRICING_USD_PER_1M,
} from './model-pricing';
import { resolveModelNameForRun } from './resolve-model';
import type { RunSubtreeRollup } from './types';

/**
 * When a run has token counts but no reported cost, estimate USD from `MODEL_PRICING_USD_PER_1M`.
 * Mutates `rollup.costUsdEstimated` and `rollup.costUsd` in place.
 */
export function applyEstimatedCostForRun(
  rollup: RunSubtreeRollup,
  node: RunNode,
  payloadCache: Record<string, unknown>,
): void {
  if (rollup.costUsdReported > 0) return;
  const promptTokens = rollup.promptTokens;
  const completionTokens = rollup.completionTokens;
  const total =
    rollup.totalTokens > 0 ? rollup.totalTokens : promptTokens + completionTokens;
  if (total <= 0 && promptTokens <= 0 && completionTokens <= 0) return;

  const modelName = resolveModelNameForRun(node, payloadCache);
  const pricingKey = lookupPricingKey(modelName);
  const pricing = pricingKey ? MODEL_PRICING_USD_PER_1M[pricingKey] : null;
  if (!pricing) return;

  const estimated = estimateCostUsdFromPricing(pricing, promptTokens, completionTokens);
  if (estimated <= 0) return;

  rollup.costUsdEstimated = estimated;
  rollup.costUsd = rollup.costUsdReported + rollup.costUsdEstimated;
  rollup.hasUsage = true;
  rollup.estimatedModel = pricingKey;
}
