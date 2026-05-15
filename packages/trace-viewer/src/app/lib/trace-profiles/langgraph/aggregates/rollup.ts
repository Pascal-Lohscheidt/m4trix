import type { TokenRollup } from './types';

/** Merge partial usage into rollup (additive). */
export function addUsageToRollup(rollup: TokenRollup, usage: Partial<TokenRollup>): void {
  if (usage.promptTokens != null) rollup.promptTokens += usage.promptTokens;
  if (usage.completionTokens != null) rollup.completionTokens += usage.completionTokens;
  if (usage.totalTokens != null) rollup.totalTokens += usage.totalTokens;
}
