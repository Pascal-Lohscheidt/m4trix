import { describe, expect, it } from 'vitest';
import { buildSubtreeRollupsByRunId } from './subtree-rollups';
import { testRun } from './test-helpers';

describe('buildSubtreeRollupsByRunId', () => {
  it('rolls up child usage into parent subtree totals', () => {
    const root = testRun({
      runId: 'parent',
      name: 'graph',
      type: 'chain',
      children: [
        testRun({
          runId: 'child',
          name: 'llm',
          type: 'llm',
          outputRef: 'o1',
        }),
      ],
    });
    const cache = {
      o1: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    };
    const byRunId = buildSubtreeRollupsByRunId(root, cache);
    expect(byRunId.get('child')?.totalTokens).toBe(15);
    expect(byRunId.get('parent')?.totalTokens).toBe(15);
  });

  it('sums usage across multiple descendants', () => {
    const root = testRun({
      runId: 'root',
      name: 'graph',
      type: 'chain',
      children: [
        testRun({ runId: 'a', name: 'a', type: 'llm', outputRef: 'o1' }),
        testRun({ runId: 'b', name: 'b', type: 'llm', outputRef: 'o2' }),
      ],
    });
    const cache = {
      o1: { usage: { total_tokens: 10 } },
      o2: { usage: { total_tokens: 20 } },
    };
    const byRunId = buildSubtreeRollupsByRunId(root, cache);
    expect(byRunId.get('a')?.totalTokens).toBe(10);
    expect(byRunId.get('b')?.totalTokens).toBe(20);
    expect(byRunId.get('root')?.totalTokens).toBe(30);
  });
});
