import { describe, expect, it } from 'vitest';
import {
  buildSubtreeRollupsByRunId,
  rollupTraceForLanggraph,
} from '../trace-profiles/langgraph/aggregates';
import { testRun } from '../trace-profiles/langgraph/aggregates/test-helpers';
import type { PayloadMapping } from './mapping-schema';
import { createMappedDirectUsage, extractMappedUsageForRun } from './usage';

const mapping: PayloadMapping = {
  schemaVersion: 1,
  rules: [],
  usage: [
    {
      match: { runType: ['chat_model'], side: 'output' },
      inputTokens: '$.meta.in',
      outputTokens: '$.meta.out',
      model: '$.meta.model',
    },
  ],
};

describe('extractMappedUsageForRun', () => {
  it('reads usage via the first matching rule', () => {
    const run = testRun({ runId: 'a', name: 'llm', type: 'chat_model', outputRef: 'o' });
    expect(
      extractMappedUsageForRun(mapping, run, {
        o: { meta: { in: 100, out: '20', model: 'gpt-4o' } },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: undefined,
      costUsd: undefined,
      model: 'gpt-4o',
    });
  });

  it('returns null when no rule matches, nothing is loaded, or there are no usage rules', () => {
    const tool = testRun({ runId: 'a', name: 't', type: 'tool', outputRef: 'o' });
    expect(extractMappedUsageForRun(mapping, tool, { o: { meta: { in: 1 } } })).toBeNull();
    const llm = testRun({ runId: 'b', name: 'l', type: 'chat_model', outputRef: 'o' });
    expect(extractMappedUsageForRun(mapping, llm, {})).toBeNull();
    expect(extractMappedUsageForRun({ schemaVersion: 1, rules: [] }, llm, { o: {} })).toBeNull();
  });
});

describe('createMappedDirectUsage', () => {
  const root = testRun({
    runId: 'root',
    name: 'graph',
    type: 'chain',
    children: [
      testRun({ runId: 'l1', name: 'llm', type: 'chat_model', outputRef: 'o1' }),
      testRun({
        runId: 'l2',
        name: 'llm',
        type: 'chat_model',
        outputRef: 'o2',
        tokens: { input: 5, output: 5 },
      }),
    ],
  });
  const cache = {
    o1: { meta: { in: 1_000_000, out: 0, model: 'gpt-4o' } },
    o2: { meta: { in: 999, out: 999 } },
  };

  it('rolls up mapped usage, prefers structure tokens, and estimates cost from the mapped model', () => {
    const direct = createMappedDirectUsage(mapping);
    const byRun = buildSubtreeRollupsByRunId(root, cache, direct);
    expect(byRun.get('l2')).toMatchObject({ promptTokens: 5, completionTokens: 5 });
    expect(byRun.get('l1')).toMatchObject({ promptTokens: 1_000_000, estimatedModel: 'gpt-4o' });
    expect(byRun.get('l1')?.costUsdEstimated).toBeCloseTo(2.5);

    const trace = rollupTraceForLanggraph(root, cache, direct);
    expect(trace.rollup.promptTokens).toBe(1_000_005);
    expect(trace.spansWithUsage).toBe(2);
  });
});
