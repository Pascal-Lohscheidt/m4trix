import { describe, expect, it } from 'vitest';
import { resolveModelNameForRun } from './resolve-model';
import { testRun } from './test-helpers';

describe('resolveModelNameForRun', () => {
  it('reads model from run metadata', () => {
    const run = testRun({
      runId: 'a',
      name: 'llm',
      type: 'chat_model',
      metadata: { model: 'gpt-4o-mini' },
    });
    expect(resolveModelNameForRun(run, {})).toBe('gpt-4o-mini');
  });

  it('reads model from output payload response_metadata', () => {
    const run = testRun({
      runId: 'a',
      name: 'llm',
      type: 'chat_model',
      outputRef: 'out',
    });
    expect(
      resolveModelNameForRun(run, {
        out: { response_metadata: { model: 'gpt-4o' } },
      }),
    ).toBe('gpt-4o');
  });
});
