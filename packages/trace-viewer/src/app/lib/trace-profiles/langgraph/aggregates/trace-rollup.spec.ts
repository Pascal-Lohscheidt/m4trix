import { describe, expect, it } from 'vitest';
import { rollupTraceForLanggraph } from './trace-rollup';
import { testRun } from './test-helpers';

describe('rollupTraceForLanggraph', () => {
  it('returns root subtree totals and span count', () => {
    const root = testRun({
      runId: 'a',
      name: 'm',
      type: 'llm',
      outputRef: 'o1',
    });
    const cache = {
      o1: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    };
    const { rollup, spansWithUsage, costUsdReported, costUsdEstimated } = rollupTraceForLanggraph(
      root,
      cache,
    );
    expect(spansWithUsage).toBe(1);
    expect(rollup.promptTokens).toBe(10);
    expect(rollup.completionTokens).toBe(5);
    expect(rollup.totalTokens).toBe(15);
    expect(costUsdReported).toBe(0);
    expect(costUsdEstimated).toBe(0);
  });
});
