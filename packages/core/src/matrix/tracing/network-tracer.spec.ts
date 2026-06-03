import { describe, expect, it } from 'vitest';
import { noopNetworkTracer, noopRunTraceScope } from './network-tracer.js';

describe('noopNetworkTracer', () => {
  it('returns a usable RunTraceScope from onAgentInvokeStart', async () => {
    const scope = await noopNetworkTracer.onAgentInvokeStart({
      agentId: 'agent-1',
      trigger: {
        name: 'message',
        meta: { runId: 'run-1', contextId: 'ctx-1' },
        payload: { text: 'hi' },
      },
    });

    expect(scope.runId).toBe('run-1');
    expect(scope.contextId).toBe('ctx-1');

    const child = scope.startRun('llm', 'gpt-4o', { prompt: 'hi' });
    await child.end({ text: 'hello' });
    await scope.flush();
  });

  it('noopRunTraceScope provides defaults', () => {
    const scope = noopRunTraceScope();
    expect(scope.runId).toBeTruthy();
    expect(scope.contextId).toBeTruthy();
  });
});
