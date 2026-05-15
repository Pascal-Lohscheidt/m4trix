import { describe, expect, it } from 'vitest';
import {
  estimateCostUsdFromPricing,
  lookupModelPricing,
  lookupPricingKey,
  MODEL_PRICING_USD_PER_1M,
  MODEL_PRICING_RULES,
  normalizeModelName,
} from './model-pricing';

describe('normalizeModelName', () => {
  it('strips provider prefixes and paths', () => {
    expect(normalizeModelName('openai:gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelName('accounts/openai/models/gpt-4o-mini')).toBe('gpt-4o-mini');
  });
});

describe('MODEL_PRICING_RULES', () => {
  it('lists more specific families before broader ones', () => {
    const miniIdx = MODEL_PRICING_RULES.findIndex((r) => r.pricingKey === 'gpt-4o-mini');
    const gpt4oIdx = MODEL_PRICING_RULES.findIndex((r) => r.pricingKey === 'gpt-4o');
    expect(miniIdx).toBeGreaterThanOrEqual(0);
    expect(gpt4oIdx).toBeGreaterThanOrEqual(0);
    expect(miniIdx).toBeLessThan(gpt4oIdx);
  });
});

describe('lookupPricingKey', () => {
  it('matches exact canonical ids', () => {
    expect(lookupPricingKey('gpt-4o')).toBe('gpt-4o');
  });

  it('matches dated OpenAI snapshots via regex', () => {
    expect(lookupPricingKey('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(lookupPricingKey('gpt-4o-2024-11-20')).toBe('gpt-4o');
    expect(lookupPricingKey('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini');
  });

  it('matches Claude dated and variant ids', () => {
    expect(lookupPricingKey('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet');
    expect(lookupPricingKey('claude-sonnet-4-20250514')).toBe('claude-sonnet-4');
    expect(lookupPricingKey('claude-sonnet-4-6')).toBe('claude-sonnet-4');
    expect(lookupPricingKey('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
  });

  it('matches legacy turbo aliases to gpt-4o', () => {
    expect(lookupPricingKey('gpt-4-turbo-preview')).toBe('gpt-4o');
    expect(lookupPricingKey('chatgpt-4o-latest')).toBe('gpt-4o');
  });

  it('does not let o1 match o1-mini', () => {
    expect(lookupPricingKey('o1-mini')).toBe('o1-mini');
    expect(lookupPricingKey('o1-mini-2024-09-12')).toBe('o1-mini');
    expect(lookupPricingKey('o1-2024-12-17')).toBe('o1');
  });

  it('returns null for unknown models', () => {
    expect(lookupPricingKey('totally-unknown-model-xyz')).toBeNull();
  });
});

describe('lookupModelPricing', () => {
  it('returns pricing for resolved keys', () => {
    expect(lookupModelPricing('gpt-4o-2024-08-06')?.outputUsdPer1M).toBe(10);
    expect(lookupModelPricing('claude-3-5-sonnet-20241022')?.inputUsdPer1M).toBe(3);
  });
});

describe('estimateCostUsdFromPricing', () => {
  it('computes input and output cost from per-1M rates', () => {
    const pricing = MODEL_PRICING_USD_PER_1M['gpt-4o-mini'];
    const cost = estimateCostUsdFromPricing(pricing, 1_000_000, 500_000);
    expect(cost).toBeCloseTo(0.15 + 0.3, 6);
  });
});
