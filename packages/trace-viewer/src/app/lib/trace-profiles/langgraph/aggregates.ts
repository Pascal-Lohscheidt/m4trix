import type { RunNode } from '../../../types';

export type TokenRollup = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Merge partial usage into rollup (additive). */
export function addUsageToRollup(rollup: TokenRollup, usage: Partial<TokenRollup>): void {
  if (usage.promptTokens != null) rollup.promptTokens += usage.promptTokens;
  if (usage.completionTokens != null) rollup.completionTokens += usage.completionTokens;
  if (usage.totalTokens != null) rollup.totalTokens += usage.totalTokens;
}

/**
 * Best-effort extraction from common LLM / LangChain response shapes.
 * Avoids double-counting when both total and prompt+completion exist.
 */
export function extractUsageFromUnknown(
  value: unknown,
): Partial<TokenRollup> & { costUsd?: number } {
  const out: Partial<TokenRollup> & { costUsd?: number } = {};
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || v == null) return;
    const o = asRecord(v);
    if (!o) {
      if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
      return;
    }

    const cost =
      num(o.costUsd) ??
      num(o.cost_usd) ??
      num(o.total_cost) ??
      (asRecord(o.cost) ? num(asRecord(o.cost)?.total) : null);
    if (cost != null) out.costUsd = (out.costUsd ?? 0) + cost;

    const usage = o.usage ?? o.token_usage ?? o.usage_metadata;
    const u = asRecord(usage);
    if (u) {
      const pt =
        num(u.prompt_tokens) ??
        num(u.input_tokens) ??
        num(u.promptTokens) ??
        num(u.promptTokenCount);
      const ct =
        num(u.completion_tokens) ??
        num(u.output_tokens) ??
        num(u.completionTokens) ??
        num(u.candidatesTokenCount);
      const tt = num(u.total_tokens) ?? num(u.totalTokens) ?? num(u.totalTokenCount);
      if (pt != null) out.promptTokens = (out.promptTokens ?? 0) + pt;
      if (ct != null) out.completionTokens = (out.completionTokens ?? 0) + ct;
      if (tt != null) out.totalTokens = (out.totalTokens ?? 0) + tt;
    }

    for (const k of [
      'response',
      'response_metadata',
      'kwargs',
      'lc_kwargs',
      'additional_kwargs',
      'message',
    ]) {
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

export function extractMetadataUsage(meta: Record<string, string | number | boolean> | undefined): {
  tokens?: Partial<TokenRollup>;
  costUsd?: number;
} {
  if (!meta) return {};
  const o = meta as Record<string, unknown>;
  const pt = num(o.prompt_tokens) ?? num(o.input_tokens) ?? num(o.promptTokens);
  const ct = num(o.completion_tokens) ?? num(o.output_tokens) ?? num(o.completionTokens);
  const tt = num(o.total_tokens) ?? num(o.totalTokens);
  const cost = num(o.costUsd) ?? num(o.cost_usd);
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

export function rollupTraceForLanggraph(
  root: RunNode,
  payloadCache: Record<string, unknown>,
): { rollup: TokenRollup; costUsdReported: number; spansWithUsage: number } {
  const rollup: TokenRollup = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let costUsdReported = 0;
  let spansWithUsage = 0;

  const visit = (node: RunNode) => {
    const fromMeta = extractMetadataUsage(node.metadata);
    if (fromMeta.tokens) {
      const u = fromMeta.tokens;
      if (u.promptTokens != null || u.completionTokens != null || u.totalTokens != null) {
        spansWithUsage += 1;
        addUsageToRollup(rollup, {
          promptTokens: u.promptTokens ?? 0,
          completionTokens: u.completionTokens ?? 0,
          totalTokens: u.totalTokens ?? 0,
        });
      }
    }
    if (fromMeta.costUsd != null) costUsdReported += fromMeta.costUsd;

    for (const ref of [node.inputRef, node.outputRef]) {
      if (!ref || payloadCache[ref] === undefined) continue;
      const extracted = extractUsageFromUnknown(payloadCache[ref]);
      if (
        extracted.promptTokens != null ||
        extracted.completionTokens != null ||
        extracted.totalTokens != null
      ) {
        spansWithUsage += 1;
        addUsageToRollup(rollup, {
          promptTokens: extracted.promptTokens ?? 0,
          completionTokens: extracted.completionTokens ?? 0,
          totalTokens: extracted.totalTokens ?? 0,
        });
      }
      if (extracted.costUsd != null) costUsdReported += extracted.costUsd;
    }

    for (const child of node.children) visit(child);
  };

  visit(root);

  if (rollup.totalTokens === 0 && (rollup.promptTokens > 0 || rollup.completionTokens > 0)) {
    rollup.totalTokens = rollup.promptTokens + rollup.completionTokens;
  }

  return { rollup, costUsdReported, spansWithUsage };
}
