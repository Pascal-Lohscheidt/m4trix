import { describe, expect, it } from 'vitest';
import { collectPayloadRefsFromTree, isFullTracePayloadsLoaded } from './trace-profiles/types';
import { testRun } from './trace-profiles/langgraph/aggregates/test-helpers';

describe('collectPayloadRefsFromTree', () => {
  it('collects unique input and output refs', () => {
    const root = testRun({
      runId: 'a',
      name: 'root',
      type: 'chain',
      inputRef: 'in1',
      outputRef: 'out1',
      children: [
        testRun({
          runId: 'b',
          name: 'c',
          type: 'llm',
          inputRef: 'in1',
          outputRef: 'out2',
        }),
      ],
    });
    expect(collectPayloadRefsFromTree(root).sort()).toEqual(['in1', 'out1', 'out2']);
  });
});

describe('isFullTracePayloadsLoaded', () => {
  it('is true when cache has all refs', () => {
    const root = testRun({
      runId: 'a',
      name: 'r',
      type: 'chain',
      inputRef: 'i',
    });
    expect(isFullTracePayloadsLoaded(root, { i: {} })).toBe(true);
    expect(isFullTracePayloadsLoaded(root, {})).toBe(false);
  });
});
