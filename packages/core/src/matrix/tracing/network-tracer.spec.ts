import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  consoleNetworkTracer,
  guardNetworkTracer,
  type NetworkTraceEndOptions,
  type NetworkTracer,
  type NetworkTraceStatus,
  noopNetworkTracer,
  noopRunTraceScope,
  type RunTraceScope,
} from './network-tracer.js';

const trigger = {
  name: 'message',
  meta: { runId: 'run-1', contextId: 'ctx-1' },
  payload: { text: 'hi' },
};

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

describe('guardNetworkTracer', () => {
  const failing = (mode: 'throw' | 'reject'): NetworkTracer => {
    const fail = (): never => {
      throw new Error(`${mode} failure`);
    };
    const hook = mode === 'throw' ? fail : async () => fail();
    return {
      onRunStart: hook,
      onRunEnd: hook,
      onEventPublish: hook,
      onAgentInvokeStart: hook,
      onAgentInvokeEnd: hook,
      flush: hook,
    };
  };

  it.each([
    'throw',
    'reject',
  ] as const)('resolves every hook and reports the failure when the tracer fails (%s)', async (mode) => {
    const onError = vi.fn();
    const guarded = guardNetworkTracer(failing(mode), onError);

    await expect(guarded.onRunStart(trigger.meta)).resolves.toBeUndefined();
    await expect(
      guarded.onEventPublish({ channel: 'main', name: 'message', meta: trigger.meta, payload: 1 }),
    ).resolves.toBeUndefined();
    const scope = await guarded.onAgentInvokeStart({ agentId: 'agent-1', trigger });
    await expect(
      guarded.onAgentInvokeEnd(scope, new Error('agent failed')),
    ).resolves.toBeUndefined();
    await expect(guarded.onRunEnd(trigger.meta)).resolves.toBeUndefined();
    await expect(guarded.flush()).resolves.toBeUndefined();

    // A stand-in with its own run id, so nothing nests under (or ends) the trigger's run; its
    // end is not forwarded, since the tracer never started that invocation.
    expect(scope.contextId).toBe('ctx-1');
    expect(scope.runId).not.toBe('run-1');
    expect(onError.mock.calls.map(([, hook]) => hook)).toEqual([
      'onRunStart',
      'onEventPublish',
      'onAgentInvokeStart',
      'onRunEnd',
      'flush',
    ]);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('guards the run scope and spans the tracer hands out', async () => {
    const onError = vi.fn();
    const tracer: NetworkTracer = {
      ...noopNetworkTracer,
      onAgentInvokeStart: async () => ({
        runId: 'agent-run',
        contextId: 'ctx-1',
        startRun: (type) => {
          if (type === 'tool') throw new Error('cannot start');
          return {
            runId: 'llm-run',
            end: async () => {
              throw new Error('cannot end');
            },
          };
        },
        flush: async () => {
          throw new Error('cannot flush');
        },
      }),
    };
    const scope = await guardNetworkTracer(tracer, onError).onAgentInvokeStart({
      agentId: 'agent-1',
      trigger,
    });

    const llm = scope.startRun('llm', 'model', {});
    await expect(llm.end('output')).resolves.toBeUndefined();
    const tool = scope.startRun('tool', 'search', {});
    await expect(tool.end()).resolves.toBeUndefined();
    await expect(scope.flush()).resolves.toBeUndefined();

    expect(scope.runId).toBe('agent-run');
    expect(llm.runId).toBe('llm-run');
    expect(typeof tool.runId).toBe('string');
    expect(onError.mock.calls.map(([, hook]) => hook)).toEqual([
      'span.end',
      'scope.startRun',
      'scope.flush',
    ]);
  });

  it('reports a failing onAgentInvokeEnd for an invocation it started', async () => {
    const onError = vi.fn();
    const guarded = guardNetworkTracer(
      {
        ...noopNetworkTracer,
        onAgentInvokeEnd: async () => {
          throw new Error('end failed');
        },
      },
      onError,
    );

    const scope = await guarded.onAgentInvokeStart({ agentId: 'agent-1', trigger });
    await expect(guarded.onAgentInvokeEnd(scope)).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'onAgentInvokeEnd');
  });

  it('hands the tracer its own scope back, getters and identity intact', async () => {
    class ClassScope implements RunTraceScope {
      contextId = 'ctx-1';
      get runId(): string {
        return 'agent-run';
      }
      startRun() {
        return { runId: 'span', end: async () => {} };
      }
      async flush(): Promise<void> {}
    }
    const created: RunTraceScope[] = [];
    const ended: RunTraceScope[] = [];
    const guarded = guardNetworkTracer({
      ...noopNetworkTracer,
      onAgentInvokeStart: async () => {
        const scope = new ClassScope();
        created.push(scope);
        return scope;
      },
      onAgentInvokeEnd: async (scope) => {
        ended.push(scope);
      },
    });

    const scope = await guarded.onAgentInvokeStart({ agentId: 'agent-1', trigger });
    await guarded.onAgentInvokeEnd(scope);

    expect(scope.runId).toBe('agent-run');
    expect(scope.contextId).toBe('ctx-1');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toBe(created[0]);
  });

  it('does not end any run for an invocation whose start failed', async () => {
    const onAgentInvokeEnd = vi.fn(async () => {});
    const guarded = guardNetworkTracer(
      {
        ...noopNetworkTracer,
        onAgentInvokeStart: async () => {
          throw new Error('start failed');
        },
        onAgentInvokeEnd,
      },
      () => {},
    );

    const scope = await guarded.onAgentInvokeStart({ agentId: 'agent-1', trigger });
    await guarded.onAgentInvokeEnd(scope, new Error('agent failed'));

    expect(onAgentInvokeEnd).not.toHaveBeenCalled();
  });

  it('stays safe when the error handler itself throws', async () => {
    const guarded = guardNetworkTracer(failing('reject'), () => {
      throw new Error('handler broke');
    });

    await expect(guarded.onRunStart(trigger.meta)).resolves.toBeUndefined();
  });

  it('passes results through untouched when the tracer works', async () => {
    const onRunStart = vi.fn(async () => {});
    const guarded = guardNetworkTracer({ ...noopNetworkTracer, onRunStart });

    await guarded.onRunStart(trigger.meta);

    expect(onRunStart).toHaveBeenCalledWith(trigger.meta);
  });

  it('does not wrap a tracer twice', () => {
    const guarded = guardNetworkTracer(noopNetworkTracer);

    expect(guardNetworkTracer(guarded)).toBe(guarded);
    expectTypeOf(guarded).toEqualTypeOf<NetworkTracer>();
  });
});

describe('trace end status', () => {
  it('forwards the end status through a guarded tracer', async () => {
    const onRunEnd = vi.fn(async () => {});
    const onAgentInvokeEnd = vi.fn(async () => {});
    const guarded = guardNetworkTracer({ ...noopNetworkTracer, onRunEnd, onAgentInvokeEnd });
    const cancelled = new Error('cancelled');

    await guarded.onRunEnd(trigger.meta, cancelled, { status: 'cancelled' });
    const scope = await guarded.onAgentInvokeStart({ agentId: 'agent-1', trigger });
    await guarded.onAgentInvokeEnd(scope, undefined, { status: 'ok' });

    expect(onRunEnd).toHaveBeenCalledWith(trigger.meta, cancelled, { status: 'cancelled' });
    expect(onAgentInvokeEnd).toHaveBeenCalledWith(expect.anything(), undefined, { status: 'ok' });
  });

  it('logs cancelled runs as cancelled, not as errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await consoleNetworkTracer.onRunEnd(trigger.meta, new Error('client went away'), {
        status: 'cancelled',
      });
      await consoleNetworkTracer.onRunEnd(trigger.meta, new Error('boom'));

      expect(log.mock.calls[0]?.[0]).toContain('status=cancelled');
      expect(log.mock.calls[1]?.[0]).toContain('status=error');
    } finally {
      log.mockRestore();
    }
  });

  it('types the status option and keeps two-argument tracers assignable', () => {
    expectTypeOf<NetworkTraceStatus>().toEqualTypeOf<'ok' | 'error' | 'cancelled'>();
    expectTypeOf<NetworkTraceEndOptions>().toEqualTypeOf<{ status: NetworkTraceStatus }>();
    expectTypeOf<Parameters<NetworkTracer['onRunEnd']>>().toEqualTypeOf<
      [meta: { runId: string; contextId: string }, error?: Error, options?: NetworkTraceEndOptions]
    >();
    expectTypeOf<Parameters<NetworkTracer['onAgentInvokeEnd']>>().toEqualTypeOf<
      [scope: RunTraceScope, error?: Error, options?: NetworkTraceEndOptions]
    >();
    // Tracers written before the status option still satisfy the type.
    const legacy: NetworkTracer = {
      ...noopNetworkTracer,
      onRunEnd: async (_meta, _error) => {},
      onAgentInvokeEnd: async (_scope, _error) => {},
    };
    expectTypeOf(legacy).toEqualTypeOf<NetworkTracer>();
  });
});
