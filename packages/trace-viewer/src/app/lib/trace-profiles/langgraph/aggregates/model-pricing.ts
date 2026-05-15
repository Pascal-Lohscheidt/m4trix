/**
 * Static USD pricing per 1M tokens (input / output).
 *
 * There is no stable, vendor-neutral free pricing API with guaranteed uptime; options
 * include OpenRouter's `/api/v1/models`, LiteLLM's `model_prices_and_context_window.json`
 * on GitHub, and provider docs. This table is offline, versioned in-repo, and meant for
 * viewer estimates when traces lack reported `costUsd`.
 *
 * Rates are approximate — verify against provider pricing pages before billing use.
 * @see https://openai.com/api/pricing/
 * @see https://docs.anthropic.com/en/docs/about-claude/pricing
 */
export type ModelPricingUsdPer1M = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
};

export type ModelPricingRule = {
  /** Canonical key in `MODEL_PRICING_USD_PER_1M`. */
  pricingKey: string;
  /** Matched against the normalized model id (most specific rules first). */
  pattern: RegExp;
};

/** Normalized model id → price per 1M tokens (USD). */
export const MODEL_PRICING_USD_PER_1M: Record<string, ModelPricingUsdPer1M> = {
  // OpenAI — chat
  'gpt-4o': { inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  'gpt-4o-mini': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  'gpt-4.1': { inputUsdPer1M: 2.0, outputUsdPer1M: 8.0 },
  'gpt-4.1-mini': { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  'gpt-4.1-nano': { inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  'gpt-3.5-turbo': { inputUsdPer1M: 0.5, outputUsdPer1M: 1.5 },
  o1: { inputUsdPer1M: 15, outputUsdPer1M: 60 },
  'o1-mini': { inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
  'o3-mini': { inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
  // Anthropic — Claude
  'claude-3-5-sonnet': { inputUsdPer1M: 3, outputUsdPer1M: 15 },
  'claude-3-5-haiku': { inputUsdPer1M: 0.8, outputUsdPer1M: 4 },
  'claude-3-opus': { inputUsdPer1M: 15, outputUsdPer1M: 75 },
  'claude-sonnet-4': { inputUsdPer1M: 3, outputUsdPer1M: 15 },
  'claude-haiku-4.5': { inputUsdPer1M: 1, outputUsdPer1M: 5 },
  'claude-opus-4': { inputUsdPer1M: 15, outputUsdPer1M: 75 },
  // Embeddings (output priced at 0 — no completion tokens billed)
  'text-embedding-3-small': { inputUsdPer1M: 0.02, outputUsdPer1M: 0 },
  'text-embedding-3-large': { inputUsdPer1M: 0.13, outputUsdPer1M: 0 },
  // Example / local mocks
  mock: { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
};

/**
 * Regex rules for model families (order = specificity). Dates, snapshots, and minor
 * suffixes after the family id are ignored when they appear as `-20241022`, `@latest`, etc.
 */
export const MODEL_PRICING_RULES: readonly ModelPricingRule[] = [
  { pricingKey: 'text-embedding-3-large', pattern: /^text-embedding-3-large/ },
  { pricingKey: 'text-embedding-3-small', pattern: /^text-embedding-3-small/ },
  { pricingKey: 'mock', pattern: /(?:^|[-/])mock(?:$|[-/])/ },
  { pricingKey: 'gpt-4.1-nano', pattern: /^gpt-4\.1-nano/ },
  { pricingKey: 'gpt-4.1-mini', pattern: /^gpt-4\.1-mini/ },
  { pricingKey: 'gpt-4.1', pattern: /^gpt-4\.1(?:-|$|@)/ },
  { pricingKey: 'gpt-4o-mini', pattern: /^gpt-4o-mini/ },
  { pricingKey: 'gpt-4o', pattern: /^gpt-4o(?:-|$|@)|^gpt-4-turbo|^chatgpt-4o/ },
  { pricingKey: 'gpt-3.5-turbo', pattern: /^gpt-3(?:\.5|-)/ },
  { pricingKey: 'o1-mini', pattern: /^o1-mini/ },
  { pricingKey: 'o3-mini', pattern: /^o3-mini/ },
  { pricingKey: 'o1', pattern: /^o1(?:-|$|@)/ },
  { pricingKey: 'claude-3-5-haiku', pattern: /^claude-3-5-haiku/ },
  { pricingKey: 'claude-haiku-4.5', pattern: /^claude-haiku-4(?:[.-]|$|-)/ },
  { pricingKey: 'claude-3-5-sonnet', pattern: /^claude-3-5-sonnet/ },
  { pricingKey: 'claude-sonnet-4', pattern: /^claude-sonnet-4/ },
  { pricingKey: 'claude-3-opus', pattern: /^claude-3-opus/ },
  { pricingKey: 'claude-opus-4', pattern: /^claude-opus-4/ },
];

export function normalizeModelName(raw: string): string {
  let name = raw.trim().toLowerCase();
  if (!name) return name;
  if (name.includes(':')) name = (name.split(':').pop() ?? name).trim();
  if (name.includes('/')) name = (name.split('/').pop() ?? name).trim();
  return name;
}

/** Resolve a raw model string to a canonical pricing table key. */
export function lookupPricingKey(rawModel: string | null | undefined): string | null {
  if (!rawModel?.trim()) return null;
  const normalized = normalizeModelName(rawModel);
  if (!normalized) return null;

  if (MODEL_PRICING_USD_PER_1M[normalized]) return normalized;

  for (const rule of MODEL_PRICING_RULES) {
    if (rule.pattern.test(normalized)) return rule.pricingKey;
  }
  return null;
}

export function lookupModelPricing(rawModel: string | null | undefined): ModelPricingUsdPer1M | null {
  const key = lookupPricingKey(rawModel);
  if (!key) return null;
  return MODEL_PRICING_USD_PER_1M[key] ?? null;
}

export function estimateCostUsdFromPricing(
  pricing: ModelPricingUsdPer1M,
  promptTokens: number,
  completionTokens: number,
): number {
  const inputCost = (promptTokens / 1_000_000) * pricing.inputUsdPer1M;
  const outputCost = (completionTokens / 1_000_000) * pricing.outputUsdPer1M;
  return inputCost + outputCost;
}
