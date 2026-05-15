import { describe, expect, it } from 'vitest';
import { directUsageForRun } from './direct-usage';
import { testRun } from './test-helpers';

describe('directUsageForRun', () => {
  it('reads tokens from run record when present', () => {
    const run = testRun({
      runId: 'llm',
      name: 'chat',
      type: 'chat_model',
      tokens: { input: 100, output: 25 },
    });
    const usage = directUsageForRun(run, {});
    expect(usage.totalTokens).toBe(125);
    expect(usage.hasUsage).toBe(true);
  });

  it('reads usage from loaded output payload', () => {
    const run = testRun({
      runId: 'llm',
      name: 'chat',
      type: 'llm',
      outputRef: 'out',
    });
    const usage = directUsageForRun(run, {
      out: { usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    });
    expect(usage.totalTokens).toBe(10);
    expect(usage.hasUsage).toBe(true);
  });

  it('returns empty rollup when nothing is available', () => {
    const run = testRun({ runId: 'x', name: 'chain', type: 'chain' });
    const usage = directUsageForRun(run, {});
    expect(usage.hasUsage).toBe(false);
    expect(usage.totalTokens).toBe(0);
  });
});
