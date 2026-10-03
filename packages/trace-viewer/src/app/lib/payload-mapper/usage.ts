import {
  addUsageToRollup,
  applyEstimatedCostForRun,
  type DirectUsageFn,
  emptySubtreeRollup,
  finalizeTokenRollup,
  readFiniteNumber,
  type RunSubtreeRollup,
  syncRollupCostTotal,
} from '../trace-profiles/langgraph/aggregates';
import type { RunNode } from '../../types';
import { evaluateFirst } from './json-path';
import type { PayloadMapping, UsageRule } from './mapping-schema';
import { matchesRule, type PayloadSide } from './match';

export type MappedUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
};

function readNumber(payload: unknown, path: string | undefined): number | undefined {
  if (!path) return undefined;
  return readFiniteNumber(evaluateFirst(payload, path)) ?? undefined;
}

export function extractUsageWithRule(rule: UsageRule, payload: unknown): MappedUsage {
  const model = rule.model ? evaluateFirst(payload, rule.model) : undefined;
  return {
    promptTokens: readNumber(payload, rule.inputTokens),
    completionTokens: readNumber(payload, rule.outputTokens),
    totalTokens: readNumber(payload, rule.totalTokens),
    costUsd: readNumber(payload, rule.costUsd),
    model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
  };
}

function hasAny(usage: MappedUsage): boolean {
  return (
    usage.promptTokens != null ||
    usage.completionTokens != null ||
    usage.totalTokens != null ||
    usage.costUsd != null
  );
}

const SIDE_ORDER: { side: PayloadSide; ref: 'outputRef' | 'inputRef' }[] = [
  { side: 'output', ref: 'outputRef' },
  { side: 'input', ref: 'inputRef' },
];

/**
 * Usage for one run from the mapping's `usage` rules. Output payload is checked first;
 * the input payload is only used when the output yields nothing (avoids double counting).
 */
export function extractMappedUsageForRun(
  mapping: PayloadMapping,
  node: RunNode,
  payloadCache: Record<string, unknown>,
): MappedUsage | null {
  const rules = mapping.usage ?? [];
  if (rules.length === 0) return null;
  for (const { side, ref } of SIDE_ORDER) {
    const refId = node[ref];
    if (!refId || payloadCache[refId] === undefined) continue;
    const payload = payloadCache[refId];
    const rule = rules.find((r) => !r.match || matchesRule(r.match, { run: node, side, payload }));
    if (!rule) continue;
    const usage = extractUsageWithRule(rule, payload);
    if (hasAny(usage) || usage.model) return usage;
  }
  return null;
}

/** `DirectUsageFn` that combines structure-level tokens/cost with mapping usage rules. */
export function createMappedDirectUsage(mapping: PayloadMapping): DirectUsageFn {
  return (node, payloadCache): RunSubtreeRollup => {
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

    const mapped = extractMappedUsageForRun(mapping, node, payloadCache);
    // Structure-level tokens win; mapped payload usage only fills in when they are absent.
    if (mapped && !rollup.hasUsage) {
      if (
        mapped.promptTokens != null ||
        mapped.completionTokens != null ||
        mapped.totalTokens != null
      ) {
        rollup.hasUsage = true;
        addUsageToRollup(rollup, {
          promptTokens: mapped.promptTokens ?? 0,
          completionTokens: mapped.completionTokens ?? 0,
          totalTokens: mapped.totalTokens ?? 0,
        });
      }
      if (mapped.costUsd != null) {
        rollup.costUsdReported += mapped.costUsd;
        rollup.hasUsage = true;
      }
    }

    finalizeTokenRollup(rollup);
    applyEstimatedCostForRun(rollup, node, payloadCache, mapped?.model);
    syncRollupCostTotal(rollup);
    return rollup;
  };
}
