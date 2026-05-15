import type { ExtractedUsage } from './types';
import { asRecord, readFiniteNumber } from './utils';

const NESTED_USAGE_KEYS = [
  'response',
  'response_metadata',
  'kwargs',
  'lc_kwargs',
  'additional_kwargs',
  'message',
] as const;

/**
 * Best-effort extraction from common LLM / LangChain response shapes.
 * Walks nested objects up to a fixed depth and sums usage fields found.
 */
export function extractUsageFromUnknown(value: unknown): ExtractedUsage {
  const out: ExtractedUsage = {};

  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || v == null) return;
    const o = asRecord(v);
    if (!o) {
      if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
      return;
    }

    const cost =
      readFiniteNumber(o.costUsd) ??
      readFiniteNumber(o.cost_usd) ??
      readFiniteNumber(o.total_cost) ??
      (asRecord(o.cost) ? readFiniteNumber(asRecord(o.cost)?.total) : null);
    if (cost != null) out.costUsd = (out.costUsd ?? 0) + cost;

    const usage = o.usage ?? o.token_usage ?? o.usage_metadata;
    const u = asRecord(usage);
    if (u) {
      const pt =
        readFiniteNumber(u.prompt_tokens) ??
        readFiniteNumber(u.input_tokens) ??
        readFiniteNumber(u.promptTokens) ??
        readFiniteNumber(u.promptTokenCount);
      const ct =
        readFiniteNumber(u.completion_tokens) ??
        readFiniteNumber(u.output_tokens) ??
        readFiniteNumber(u.completionTokens) ??
        readFiniteNumber(u.candidatesTokenCount);
      const tt =
        readFiniteNumber(u.total_tokens) ??
        readFiniteNumber(u.totalTokens) ??
        readFiniteNumber(u.totalTokenCount);
      if (pt != null) out.promptTokens = (out.promptTokens ?? 0) + pt;
      if (ct != null) out.completionTokens = (out.completionTokens ?? 0) + ct;
      if (tt != null) out.totalTokens = (out.totalTokens ?? 0) + tt;
    }

    for (const k of NESTED_USAGE_KEYS) {
      if (k in o) walk(o[k], depth + 1);
    }
    if (Array.isArray(o.messages)) for (const m of o.messages) walk(m, depth + 1);
  };

  walk(value, 0);

  if (out.totalTokens == null && out.promptTokens != null && out.completionTokens != null) {
    out.totalTokens = out.promptTokens + out.completionTokens;
  }
  return out;
}
