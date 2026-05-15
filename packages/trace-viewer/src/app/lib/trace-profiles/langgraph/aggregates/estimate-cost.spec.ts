import { describe, expect, it } from 'vitest';
import { directUsageForRun } from './direct-usage';
import { testRun } from './test-helpers';

describe('applyEstimatedCostForRun via directUsageForRun', () => {
  it('estimates cost when tokens exist, model is known, and no reported cost', () => {
    const run = testRun({
      runId: 'llm',
      name: 'chat',
      type: 'chat_model',
      metadata: { model: 'gpt-4o-mini' },
      outputRef: 'out',
    });
    const usage = directUsageForRun(run, {
      out: { usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 } },
    });
    expect(usage.costUsdReported).toBe(0);
    expect(usage.costUsdEstimated).toBeGreaterThan(0);
    expect(usage.costUsd).toBe(usage.costUsdEstimated);
    expect(usage.estimatedModel).toBe('gpt-4o-mini');
  });

  it('does not estimate when reported cost is present', () => {
    const run = testRun({
      runId: 'llm',
      name: 'chat',
      type: 'chat_model',
      metadata: { model: 'gpt-4o-mini', cost_usd: 0.5 },
      outputRef: 'out',
    });
    const usage = directUsageForRun(run, {
      out: { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
    });
    expect(usage.costUsdReported).toBe(0.5);
    expect(usage.costUsdEstimated).toBe(0);
  });
});
