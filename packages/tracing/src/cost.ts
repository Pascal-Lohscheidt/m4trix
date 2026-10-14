import type { TraceTokens } from './types.js';

/** What a {@link CostCalculator} prices: one model call. */
export type CostInput = {
  model?: string;
  provider?: string;
  tokens: TraceTokens;
};

/** Returns the USD cost of a model call, or `undefined` when it cannot price it. */
export type CostCalculator = (input: CostInput) => number | undefined;

/** USD per one million tokens. Cache rates default to the input rate. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/**
 * Prices calls from a table keyed by model id. A model matches its exact key or else the longest
 * key it starts with, so `gpt-4o` covers `gpt-4o-2024-08-06` while `gpt-4o-mini` keeps its own
 * price. The library ships no prices: they change too often to hard-code.
 */
export function priceTable(prices: Record<string, ModelPrice>): CostCalculator {
  const keys = Object.keys(prices).sort((left, right) => right.length - left.length);
  return ({ model, tokens }) => {
    if (!model) return undefined;
    const key = model in prices ? model : keys.find((candidate) => model.startsWith(candidate));
    if (key === undefined) return undefined;
    return costOf(tokens, prices[key]);
  };
}

export function costOf(tokens: TraceTokens, price: ModelPrice): number {
  const cacheRead = tokens.cached ?? 0;
  const cacheWrite = tokens.cacheCreation ?? 0;
  const uncachedInput = Math.max(0, tokens.input - cacheRead - cacheWrite);
  const usd =
    uncachedInput * price.input +
    cacheRead * (price.cacheRead ?? price.input) +
    cacheWrite * (price.cacheWrite ?? price.input) +
    tokens.output * price.output;
  return usd / 1_000_000;
}

/** Adds token counts; detail counts are kept only when some side reported them. */
export function addTokens(left: TraceTokens | undefined, right: TraceTokens): TraceTokens {
  const sum: TraceTokens = {
    input: (left?.input ?? 0) + right.input,
    output: (left?.output ?? 0) + right.output,
  };
  for (const key of ['cached', 'cacheCreation', 'reasoning'] as const) {
    if (left?.[key] === undefined && right[key] === undefined) continue;
    sum[key] = (left?.[key] ?? 0) + (right[key] ?? 0);
  }
  return sum;
}
