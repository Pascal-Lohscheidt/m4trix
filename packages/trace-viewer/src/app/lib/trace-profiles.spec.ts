import { describe, expect, it } from 'vitest';
import type { RunNode } from '../types';
import { rollupTraceForLanggraph } from './trace-profiles/langgraph/aggregates';
import { collectPayloadRefsFromTree, isFullTracePayloadsLoaded } from './trace-profiles/types';

function node(partial: Partial<RunNode> & Pick<RunNode, 'runId' | 'name' | 'type'>): RunNode {
  return {
    status: 'success',
    startTime: 't0',
    ...partial,
    children: partial.children ?? [],
  };
}

describe('collectPayloadRefsFromTree', () => {
  it('collects unique input and output refs', () => {
    const root = node({
      runId: 'a',
      name: 'root',
      type: 'chain',
      inputRef: 'in1',
      outputRef: 'out1',
      children: [
        node({
          runId: 'b',
          name: 'c',
          type: 'llm',
          inputRef: 'in1',
          outputRef: 'out2',
          children: [],
        }),
      ],
    });
    expect(collectPayloadRefsFromTree(root).sort()).toEqual(['in1', 'out1', 'out2']);
  });
});

describe('isFullTracePayloadsLoaded', () => {
  it('is true when cache has all refs', () => {
    const root = node({
      runId: 'a',
      name: 'r',
      type: 'chain',
      inputRef: 'i',
      children: [],
    });
    expect(isFullTracePayloadsLoaded(root, { i: {} })).toBe(true);
    expect(isFullTracePayloadsLoaded(root, {})).toBe(false);
  });
});

describe('rollupTraceForLanggraph', () => {
  it('sums OpenAI-style usage from a loaded output payload', () => {
    const root = node({
      runId: 'a',
      name: 'm',
      type: 'llm',
      children: [],
      outputRef: 'o1',
    });
    const cache = {
      o1: {
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    };
    const { rollup, spansWithUsage } = rollupTraceForLanggraph(root, cache);
    expect(spansWithUsage).toBeGreaterThan(0);
    expect(rollup.promptTokens).toBe(10);
    expect(rollup.completionTokens).toBe(5);
    expect(rollup.totalTokens).toBe(15);
  });
});
