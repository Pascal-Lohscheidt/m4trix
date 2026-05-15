import type { MetadataUsage, TokenRollup } from './types';
import { readFiniteNumber } from './utils';

export function extractMetadataUsage(
  meta: Record<string, string | number | boolean> | undefined,
): MetadataUsage {
  if (!meta) return {};
  const o = meta as Record<string, unknown>;
  const pt = readFiniteNumber(o.prompt_tokens) ?? readFiniteNumber(o.input_tokens) ?? readFiniteNumber(o.promptTokens);
  const ct =
    readFiniteNumber(o.completion_tokens) ??
    readFiniteNumber(o.output_tokens) ??
    readFiniteNumber(o.completionTokens);
  const tt = readFiniteNumber(o.total_tokens) ?? readFiniteNumber(o.totalTokens);
  const cost = readFiniteNumber(o.costUsd) ?? readFiniteNumber(o.cost_usd);
  const tokens: Partial<TokenRollup> = {};
  if (pt != null) tokens.promptTokens = pt;
  if (ct != null) tokens.completionTokens = ct;
  if (tt != null) tokens.totalTokens = tt;
  if (Object.keys(tokens).length === 0) return { costUsd: cost ?? undefined };
  if (
    tokens.totalTokens == null &&
    tokens.promptTokens != null &&
    tokens.completionTokens != null
  ) {
    tokens.totalTokens = tokens.promptTokens + tokens.completionTokens;
  }
  return { tokens, costUsd: cost ?? undefined };
}
