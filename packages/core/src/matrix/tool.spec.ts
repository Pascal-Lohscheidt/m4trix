import { Schema as S } from 'effect';
import { afterEach, describe, expect, expectTypeOf, test, vitest } from 'vitest';
import { Agent } from './agent.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import { DependencyLayer } from './dependency-layer.js';
import { AgentToolCollection, Tool, type ToolDefinition } from './tool.js';
import type { ToolModelResult } from './tool-errors.js';
import {
  ToolDefinitionError,
  ToolExecutionError,
  ToolInputError,
  ToolOutputError,
  ToolTimeoutError,
} from './tool-errors.js';
import type { RunTraceScope, TraceRunType } from './tracing/network-tracer.js';

describe('Tool', () => {
  test('creates tool definition with schema and dependency layers', () => {
    const dbLayer = DependencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();

    const findUser = Tool.of({ name: 'findUser', description: 'Find a user by id' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .dependsOn(dbLayer)
      .define(async ({ input, layers, toolCallId }) => {
        expectTypeOf(input).toEqualTypeOf({} as { readonly id: string });
        expectTypeOf(layers.Db.config).toEqualTypeOf({} as { readonly url: string });
        expectTypeOf(layers.Db.query).toEqualTypeOf(async (_sql: string): Promise<string> => '');
        expectTypeOf(toolCallId).toEqualTypeOf('' as string);
        const name = await layers.Db.query(input.id);
        return { name };
      });

    expect(findUser.schema.name).toBe('findUser');
    expect(findUser.schema.description).toBe('Find a user by id');
    expect(findUser.dependencyLayers).toEqual([dbLayer]);
  });

  test('bound tool decodes input and output', async () => {
    const query = vitest.fn(async () => 'Ada');
    const dbLayer = DependencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();

    const findUser = Tool.of({ name: 'findUser', description: 'Find a user by id' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .dependsOn(dbLayer)
      .define(async ({ input, layers }) => {
        const name = await layers.Db.query(input.id);
        return { name };
      });

    const bound = findUser.bind({
      layers: {
        Db: {
          config: { url: 'memory' },
          query,
        },
      },
    });

    await expect(bound.execute({ id: 123 })).rejects.toThrow();
    await expect(bound.execute({ id: 'user-1' })).resolves.toEqual({ name: 'Ada' });
    expect(query).toHaveBeenCalledWith('user-1');
  });

  test('bound tool validates output', async () => {
    const tool = Tool.of({ name: 'badTool', description: 'Returns invalid output' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .define(() => ({ name: 123 }) as unknown as { name: string });

    await expect(tool.bind({ layers: {} }).execute({ id: 'user-1' })).rejects.toThrow();
  });

  test('bound tool receives injected emit as a side effect without changing output', async () => {
    const ToolUsed = AgentNetworkEvent.of(
      'tool-used',
      S.Struct({
        toolCallId: S.String,
        toolName: S.String,
        phase: S.Literal('start', 'end'),
      }),
    );
    const emit = vitest.fn();
    const toolCallIds: string[] = [];

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ text: S.String }))
      .define(({ input, emit, toolCallId }) => {
        toolCallIds.push(toolCallId);
        emit(ToolUsed.make({ toolCallId, toolName: 'echo', phase: 'start' }));
        return input;
      });

    const bound = tool.bind({ layers: {}, emit });

    await expect(bound.execute({ text: 'hello' })).resolves.toEqual({ text: 'hello' });
    await expect(bound.execute({ text: 'again' })).resolves.toEqual({ text: 'again' });
    expect(tool.emitEvents).toEqual([ToolUsed]);
    expect(toolCallIds).toHaveLength(2);
    expect(toolCallIds[0]).toEqual(expect.any(String));
    expect(toolCallIds[1]).toEqual(expect.any(String));
    expect(toolCallIds[0]).not.toBe(toolCallIds[1]);
    expect(emit).toHaveBeenNthCalledWith(1, {
      name: 'tool-used',
      payload: { toolCallId: toolCallIds[0], toolName: 'echo', phase: 'start' },
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      name: 'tool-used',
      payload: { toolCallId: toolCallIds[1], toolName: 'echo', phase: 'start' },
    });
  });

  test('bound tool receives injected emitAndAwait', async () => {
    const ToolUsed = AgentNetworkEvent.of('tool-used', S.Struct({ text: S.String }));
    const reply = {
      name: 'tool-result',
      meta: { runId: 'run-1', contextId: 'ctx-1', correlationId: 'corr-1' },
      payload: { ok: true },
    };
    const emitAndAwait = vitest.fn(async () => reply);

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ ok: S.Boolean }))
      .define(async ({ input, emitAndAwait }) => {
        const result = await emitAndAwait(
          ToolUsed.make({ text: input.text }),
          (event) => event.name === 'tool-result',
          { timeout: '10 millis' },
        );
        return result.payload as { ok: boolean };
      });

    const bound = tool.bind({ layers: {}, emitAndAwait });

    await expect(bound.execute({ text: 'hello' })).resolves.toEqual({ ok: true });
    expect(emitAndAwait).toHaveBeenCalledWith(
      { name: 'tool-used', payload: { text: 'hello' } },
      expect.any(Function),
      { timeout: '10 millis' },
    );
  });

  test('default tool emitAndAwait rejects when unbound', async () => {
    const ToolUsed = AgentNetworkEvent.of('tool-used', S.Struct({ text: S.String }));

    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .emits([ToolUsed])
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ ok: S.Boolean }))
      .define(async ({ input, emitAndAwait }) => {
        await emitAndAwait(ToolUsed.make({ text: input.text }), (event) => event.name === 'done');
        return { ok: true };
      });

    await expect(tool.bind({ layers: {} }).execute({ text: 'hello' })).rejects.toThrow(
      'emitAndAwait is only available when the tool is running in an event plane',
    );
  });

  test('define throws when input or output schema is missing', () => {
    expect(() =>
      Tool.of({ name: 'badTool', description: 'Incomplete tool' }).define(() => null),
    ).toThrow(/Tool\.define requires input\(\) and output\(\)/);
  });

  test('throws on duplicate layer names', () => {
    const layer = DependencyLayer.of({
      name: 'Db',
      config: S.Struct({}),
    });

    expect(() =>
      Tool.of({ name: 'findUser', description: 'Find a user by id' })
        .input(S.Struct({ id: S.String }))
        .output(S.Struct({ name: S.String }))
        .dependsOn(layer)
        .dependsOn(layer)
        .define(() => ({ name: 'Ada' })),
    ).toThrow(/Duplicate layer name: Db/);
  });
});

describe('AgentToolCollection', () => {
  test('exposes raw schemas and dependency-injected tools', async () => {
    const dbLayer = DependencyLayer.of({
      name: 'Db',
      config: S.Struct({ url: S.String }),
    }).define<{ query: (sql: string) => Promise<string> }>();

    const findUser = Tool.of({ name: 'findUser', description: 'Find a user by id' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .dependsOn(dbLayer)
      .define(async ({ input, layers }) => {
        const name = await layers.Db.query(input.id);
        return { name };
      });

    const collection = new AgentToolCollection<typeof findUser, typeof dbLayer, never>(
      [findUser],
      {
        Db: {
          config: { url: 'memory' },
          query: async () => 'Ada',
        },
      },
      () => {},
    );

    expect(collection.toToolSchemas()).toEqual([findUser.schema]);
    await expect(collection.toTools()[0]?.execute({ id: 'user-1' })).resolves.toEqual({
      name: 'Ada',
    });
    expectTypeOf(collection.toToolSchemas()[0]).toEqualTypeOf(findUser.schema);
  });

  test('ToolDefinition type captures executable tool shape', () => {
    const tool = Tool.of({ name: 'echo', description: 'Echo input' })
      .input(S.Struct({ text: S.String }))
      .output(S.Struct({ text: S.String }))
      .define(({ input }) => input);

    const definition: ToolDefinition<{ text: string }, { text: string }, never> = tool;
    expect(definition.schema.name).toBe('echo');
  });
});

describe('Tool run controls', () => {
  test('execution ctx exposes signal and complete', () => {
    Tool.of({ name: 'typed', description: 'Typed run controls' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(({ signal, complete }) => {
        expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
        expectTypeOf(complete).toEqualTypeOf<() => void>();
        return {};
      });
  });

  test('bound tool receives the bound signal and complete', async () => {
    const complete = vitest.fn();
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const tool = Tool.of({ name: 'finish', description: 'Completes the run' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(({ signal, complete: done }) => {
        seen.push(signal);
        done();
        return {};
      });

    await tool.bind({ layers: {}, signal: controller.signal, complete }).execute({});

    expect(seen).toEqual([controller.signal]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('unbound tool gets a signal that never aborts and a no-op complete', async () => {
    let signal: AbortSignal | undefined;
    const tool = Tool.of({ name: 'standalone', description: 'No run' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define((ctx) => {
        signal = ctx.signal;
        ctx.complete();
        return {};
      });

    await expect(tool.bind({ layers: {} }).execute({})).resolves.toEqual({});
    expect(signal?.aborted).toBe(false);
  });

  test('AgentToolCollection threads run controls into its tools', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const tool = Tool.of({ name: 'probe', description: 'Records its signal' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define((ctx) => {
        signal = ctx.signal;
        return {};
      });
    const collection = new AgentToolCollection([tool], {}, () => {}, undefined, {
      signal: controller.signal,
    });

    await collection.toTools()[0]?.execute({});

    expect(signal).toBe(controller.signal);
  });
});

describe('Tool name validation', () => {
  test.each([
    'findUser',
    'find_user',
    'find-user',
    'a',
    'A1_b-2',
    'x'.repeat(64),
  ])('accepts provider-safe name %s', (name) => {
    expect(() => Tool.of({ name, description: 'ok' })).not.toThrow();
  });

  test.each([
    '',
    'find user',
    'find.user',
    'tool/name',
    'naïve',
    'x'.repeat(65),
  ])('rejects invalid name %j at Tool.of() time', (name) => {
    expect(() => Tool.of({ name, description: 'bad' })).toThrow(ToolDefinitionError);
    expect(() => Tool.of({ name, description: 'bad' })).toThrow(
      /must match \^\[a-zA-Z0-9_-\]\{1,64\}\$/,
    );
  });
});

describe('Tool typed errors', () => {
  const lookup = vitest.fn((_: { user: { id: string } }) => ({ name: 'Ada' }));
  const findUser = Tool.of({ name: 'findUser', description: 'Find a user' })
    .input(S.Struct({ user: S.Struct({ id: S.String }), tags: S.Array(S.String), limit: S.Number }))
    .output(S.Struct({ name: S.String }))
    .define(({ input }) => lookup(input));

  test('execute rejects invalid input with ToolInputError and path-level issues', async () => {
    lookup.mockClear();
    const error = await findUser
      .bind({ layers: {} })
      .execute({ user: { id: 1 }, tags: ['a', 2] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolInputError);
    const inputError = error as ToolInputError;
    expect(inputError._tag).toBe('ToolInputError');
    expect(inputError.toolName).toBe('findUser');
    expect(inputError.issues).toEqual([
      { path: 'user.id', message: 'Expected string, actual 1' },
      { path: 'tags[1]', message: 'Expected string, actual 2' },
      { path: 'limit', message: 'is missing' },
    ]);
    expect(inputError.message).toBe(
      'Invalid input for tool "findUser":\n' +
        '- user.id: Expected string, actual 1\n' +
        '- tags[1]: Expected string, actual 2\n' +
        '- limit: is missing',
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a root-level input issue has an empty path', async () => {
    const error = await findUser
      .bind({ layers: {} })
      .execute('not an object')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).issues).toEqual([
      { path: '', message: expect.stringContaining('actual "not an object"') },
    ]);
    expect((error as ToolInputError).message).toContain('- (root): Expected');
  });

  test('execute rejects output that fails its schema with ToolOutputError', async () => {
    const broken = Tool.of({ name: 'broken', description: 'Returns invalid output' })
      .input(S.Struct({}))
      .output(S.Struct({ name: S.String }))
      .define(() => ({ name: 123 }) as unknown as { name: string });

    const error = await broken
      .bind({ layers: {} })
      .execute({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolOutputError);
    expect((error as ToolOutputError)._tag).toBe('ToolOutputError');
    expect((error as ToolOutputError).issues).toEqual([
      { path: 'name', message: 'Expected string, actual 123' },
    ]);
    expect((error as ToolOutputError).message).toMatch(
      /^Tool "broken" returned output that does not match its output schema/,
    );
  });

  test('execute wraps a thrown error in ToolExecutionError preserving the cause', async () => {
    const cause = new Error('database is down');
    const failing = Tool.of({ name: 'failing', description: 'Throws' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(() => {
        throw cause;
      });

    const error = await failing
      .bind({ layers: {} })
      .execute({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolExecutionError);
    const executionError = error as ToolExecutionError;
    expect(executionError._tag).toBe('ToolExecutionError');
    expect(executionError.cause).toBe(cause);
    expect(executionError.attempts).toBe(1);
    expect(executionError.message).toBe('Tool "failing" failed: database is down');
  });

  test('a rejected promise and a non-Error throw are wrapped too', async () => {
    const rejecting = Tool.of({ name: 'rejecting', description: 'Rejects with a string' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(async () => Promise.reject('quota exceeded'));

    const error = await rejecting
      .bind({ layers: {} })
      .execute({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).cause).toBe('quota exceeded');
    expect((error as ToolExecutionError).message).toBe('Tool "rejecting" failed: quota exceeded');
  });

  test('error classes are typed and tagged', () => {
    expectTypeOf<ToolInputError['_tag']>().toEqualTypeOf<'ToolInputError'>();
    expectTypeOf<ToolOutputError['_tag']>().toEqualTypeOf<'ToolOutputError'>();
    expectTypeOf<ToolExecutionError['_tag']>().toEqualTypeOf<'ToolExecutionError'>();
    expectTypeOf<ToolDefinitionError['_tag']>().toEqualTypeOf<'ToolDefinitionError'>();
    expectTypeOf<ToolInputError['issues']>().toEqualTypeOf<
      ReadonlyArray<{ readonly path: string; readonly message: string }>
    >();
    expectTypeOf<ToolExecutionError['cause']>().toEqualTypeOf<unknown>();
    expectTypeOf<ToolInputError>().toExtend<Error>();
  });
});

describe('Tool executeForModel', () => {
  const greet = Tool.of({ name: 'greet', description: 'Greets someone' })
    .input(S.Struct({ name: S.String }))
    .output(S.Struct({ greeting: S.String }))
    .define(({ input }) => {
      if (input.name === 'crash') throw new Error('greeter crashed');
      if (input.name === 'bug') return { greeting: 42 } as unknown as { greeting: string };
      return { greeting: `Hello ${input.name}` };
    });
  const bound = greet.bind({ layers: {} });

  test('returns ok with the decoded output', async () => {
    await expect(bound.executeForModel({ name: 'Ada' })).resolves.toEqual({
      ok: true,
      output: { greeting: 'Hello Ada' },
    });
  });

  test('returns invalid_input with issues the model can fix', async () => {
    await expect(bound.executeForModel({ name: 7 })).resolves.toEqual({
      ok: false,
      error: {
        kind: 'invalid_input',
        message: 'Invalid input for tool "greet":\n- name: Expected string, actual 7',
        issues: [{ path: 'name', message: 'Expected string, actual 7' }],
      },
    });
  });

  test('returns execution_error with the message only, never a stack trace', async () => {
    const result = await bound.executeForModel({ name: 'crash' });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'execution_error', message: 'Tool "greet" failed: greeter crashed' },
    });
    expect(JSON.stringify(result)).not.toMatch(/\n\s+at /);
  });

  test('returns invalid_output without exposing the offending values', async () => {
    const result = await bound.executeForModel({ name: 'bug' });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid_output',
        message:
          'Tool "greet" returned an invalid result. This is a bug in the tool, not in your ' +
          'input; retrying with different arguments will not help.',
      },
    });
  });

  test('propagates cancellation instead of returning a model result', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    const slow = Tool.of({ name: 'slow', description: 'Waits for abort' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(
        ({ signal }) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
    const run = slow.bind({ layers: {}, signal: controller.signal });

    const pending = run.executeForModel({});
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await expect(run.execute({})).rejects.toBe(reason);
    await expect(run.executeForModel({})).rejects.toBe(reason);
  });

  test('cancellation wins even when the abort reason is itself a tool error', async () => {
    const controller = new AbortController();
    const reason = new ToolExecutionError('upstream', new Error('sibling tool failed'));
    const tool = Tool.of({ name: 'waits', description: 'Waits for abort' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(
        ({ signal }) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      );

    const pending = tool.bind({ layers: {}, signal: controller.signal }).executeForModel({});
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  test('a per-call signal cancels the call the same way', async () => {
    const controller = new AbortController();
    controller.abort('stop');
    const run = vitest.fn(() => ({}));
    const tool = Tool.of({ name: 'noop', description: 'Does nothing' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .define(run);

    await expect(
      tool.bind({ layers: {} }).executeForModel({}, { signal: controller.signal }),
    ).rejects.toBe('stop');
    expect(run).not.toHaveBeenCalled();
  });

  test('result type is a discriminated union over the output type', async () => {
    const result = await bound.executeForModel({ name: 'Ada' });

    expectTypeOf(result).toEqualTypeOf<ToolModelResult<{ readonly greeting: string }>>();
    if (result.ok) {
      expectTypeOf(result.output).toEqualTypeOf<{ readonly greeting: string }>();
    } else {
      expectTypeOf(result.error.kind).toEqualTypeOf<
        'invalid_input' | 'execution_error' | 'timeout' | 'invalid_output'
      >();
      expectTypeOf(result.error.message).toEqualTypeOf<string>();
      expectTypeOf(result.error.issues).toEqualTypeOf<
        ReadonlyArray<{ readonly path: string; readonly message: string }> | undefined
      >();
    }
  });
});

describe('Tool timeout', () => {
  test('rejects with ToolTimeoutError and aborts the tool signal', async () => {
    const runController = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const waits = Tool.of({ name: 'waits', description: 'Waits until aborted' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .timeout('20 millis')
      .define(({ signal }) => {
        toolSignal = signal;
        return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      });

    const error = await waits
      .bind({ layers: {}, signal: runController.signal })
      .execute({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolTimeoutError);
    expect((error as ToolTimeoutError)._tag).toBe('ToolTimeoutError');
    expect((error as ToolTimeoutError).toolName).toBe('waits');
    expect((error as ToolTimeoutError).timeoutMs).toBe(20);
    expect((error as ToolTimeoutError).message).toBe('Tool "waits" timed out after 20ms');
    expect(toolSignal?.aborted).toBe(true);
    expect(toolSignal?.reason).toBe(error);
    // The timeout aborts only this call, never the calling run.
    expect(runController.signal.aborted).toBe(false);
  });

  test('times out a tool that ignores its signal', async () => {
    const hangs = Tool.of({ name: 'hangs', description: 'Never settles' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .timeout(15)
      .define(() => new Promise<never>(() => {}));

    await expect(hangs.bind({ layers: {} }).execute({})).rejects.toBeInstanceOf(ToolTimeoutError);
    await expect(hangs.bind({ layers: {} }).executeForModel({})).resolves.toEqual({
      ok: false,
      error: { kind: 'timeout', message: 'Tool "hangs" timed out after 15ms' },
    });
  });

  test('a tool finishing in time is unaffected', async () => {
    const fast = Tool.of({ name: 'fast', description: 'Answers at once' })
      .input(S.Struct({}))
      .output(S.Struct({ ok: S.Boolean }))
      .timeout('1 second')
      .define(() => ({ ok: true }));

    await expect(fast.bind({ layers: {} }).execute({})).resolves.toEqual({ ok: true });
  });

  test.each([0, -5, Number.NaN])('rejects a non-positive timeout %s at definition', (ms) => {
    expect(() => Tool.of({ name: 'bad', description: 'Bad timeout' }).timeout(ms)).toThrow(
      ToolDefinitionError,
    );
  });

  test('timeout() preserves the builder generics', () => {
    const builder = Tool.of({ name: 'typed', description: 'Typed' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ ok: S.Boolean }));

    expectTypeOf(builder.timeout('1 second')).toEqualTypeOf(builder);
    expectTypeOf<ToolTimeoutError['_tag']>().toEqualTypeOf<'ToolTimeoutError'>();
  });
});

describe('Tool retry', () => {
  afterEach(() => {
    vitest.useRealTimers();
  });

  const flaky = (failures: number, onCall?: (call: number) => void) => {
    let calls = 0;
    const toolCallIds: string[] = [];
    const tool = Tool.of({ name: 'flaky', description: 'Fails a few times' })
      .input(S.Struct({}))
      .output(S.Struct({ calls: S.Number }))
      .retry({ times: 2 })
      .define(({ toolCallId }) => {
        calls += 1;
        toolCallIds.push(toolCallId);
        onCall?.(calls);
        if (calls <= failures) throw new Error(`failure ${calls}`);
        return { calls };
      });
    return { tool, calls: () => calls, toolCallIds };
  };

  test('retries execution errors and succeeds within the budget', async () => {
    const { tool, calls, toolCallIds } = flaky(2);

    await expect(tool.bind({ layers: {} }).execute({})).resolves.toEqual({ calls: 3 });
    expect(calls()).toBe(3);
    expect(new Set(toolCallIds).size).toBe(1);
  });

  test('gives up after times + 1 attempts with the last cause', async () => {
    const { tool, calls } = flaky(10);

    const error = await tool
      .bind({ layers: {} })
      .execute({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as ToolExecutionError).attempts).toBe(3);
    expect(((error as ToolExecutionError).cause as Error).message).toBe('failure 3');
    expect(calls()).toBe(3);
  });

  test('never retries invalid input or invalid output', async () => {
    let calls = 0;
    const tool = Tool.of({ name: 'buggy', description: 'Returns invalid output' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ name: S.String }))
      .retry({ times: 3 })
      .define(() => {
        calls += 1;
        return { name: 1 } as unknown as { name: string };
      });
    const bound = tool.bind({ layers: {} });

    await expect(bound.execute({ id: 1 })).rejects.toBeInstanceOf(ToolInputError);
    expect(calls).toBe(0);
    await expect(bound.execute({ id: 'a' })).rejects.toBeInstanceOf(ToolOutputError);
    expect(calls).toBe(1);
  });

  test('never retries a timed-out attempt', async () => {
    let calls = 0;
    const tool = Tool.of({ name: 'slow', description: 'Hangs' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .timeout(10)
      .retry({ times: 3 })
      .define(() => {
        calls += 1;
        return new Promise<never>(() => {});
      });

    await expect(tool.bind({ layers: {} }).execute({})).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(calls).toBe(1);
  });

  test('stops retrying once the signal is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('run ended');
    const { tool, calls } = flaky(10, () => controller.abort(reason));

    await expect(tool.bind({ layers: {}, signal: controller.signal }).execute({})).rejects.toBe(
      reason,
    );
    expect(calls()).toBe(1);
  });

  test('waits an exponential backoff between attempts', async () => {
    vitest.useFakeTimers();
    let calls = 0;
    const tool = Tool.of({ name: 'backoff', description: 'Fails twice' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .retry({ times: 2, backoff: { base: '100 millis', factor: 2 } })
      .define(() => {
        calls += 1;
        if (calls < 3) throw new Error('not yet');
        return {};
      });

    const pending = tool.bind({ layers: {} }).execute({});
    await vitest.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vitest.advanceTimersByTimeAsync(99);
    expect(calls).toBe(1);
    await vitest.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vitest.advanceTimersByTimeAsync(199);
    expect(calls).toBe(2);
    await vitest.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    await expect(pending).resolves.toEqual({});
  });

  test('backoff delays are capped by max', async () => {
    vitest.useFakeTimers();
    let calls = 0;
    const tool = Tool.of({ name: 'capped', description: 'Fails twice' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .retry({ times: 2, backoff: { base: '100 millis', factor: 10, max: '150 millis' } })
      .define(() => {
        calls += 1;
        if (calls < 3) throw new Error('not yet');
        return {};
      });

    const pending = tool.bind({ layers: {} }).execute({});
    await vitest.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    await vitest.advanceTimersByTimeAsync(150);
    expect(calls).toBe(3);
    await expect(pending).resolves.toEqual({});
  });

  test('an abort during the backoff wait cancels immediately', async () => {
    vitest.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    const tool = Tool.of({ name: 'waiting', description: 'Always fails' })
      .input(S.Struct({}))
      .output(S.Struct({}))
      .retry({ times: 5, backoff: { base: '1 second' } })
      .define(() => {
        calls += 1;
        throw new Error('nope');
      });

    const pending = tool
      .bind({ layers: {}, signal: controller.signal })
      .execute({})
      .catch((e: unknown) => e);
    await vitest.advanceTimersByTimeAsync(10);
    controller.abort('stop');

    await expect(pending).resolves.toBe('stop');
    expect(calls).toBe(1);
  });

  test.each([-1, 1.5, Number.NaN])('rejects invalid times %s at definition', (times) => {
    expect(() => Tool.of({ name: 'bad', description: 'Bad retry' }).retry({ times })).toThrow(
      ToolDefinitionError,
    );
  });

  test('retry() preserves the builder generics', () => {
    const builder = Tool.of({ name: 'typed', description: 'Typed' })
      .input(S.Struct({ id: S.String }))
      .output(S.Struct({ ok: S.Boolean }));

    expectTypeOf(builder.retry({ times: 1 })).toEqualTypeOf(builder);
    expectTypeOf(builder.retry({ times: 1 }).timeout('1 second')).toEqualTypeOf(builder);
  });
});

type RecordedSpan = {
  type: TraceRunType;
  name: string;
  input: unknown;
  ends: Array<{ output: unknown; error: Error | undefined }>;
};

function fakeTraceScope(): { scope: RunTraceScope; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const scope: RunTraceScope = {
    runId: 'run-1',
    contextId: 'ctx-1',
    startRun: (type, name, input) => {
      const span: RecordedSpan = { type, name, input, ends: [] };
      spans.push(span);
      return {
        runId: `span-${spans.length}`,
        end: async (output, error) => {
          span.ends.push({ output, error });
        },
      };
    },
    flush: async () => {},
  };
  return { scope, spans };
}

describe('Tool tracing', () => {
  const divide = Tool.of({ name: 'divide', description: 'Divides two numbers' })
    .input(S.Struct({ a: S.Number, b: S.Number }))
    .output(S.Struct({ result: S.Number }))
    .define(({ input }) => {
      if (input.b === 0) throw new Error('division by zero');
      return { result: input.a / input.b };
    });

  test('opens a tool span with the raw input and ends it with the output', async () => {
    const { scope, spans } = fakeTraceScope();

    await divide.bind({ layers: {}, tracing: scope }).execute({ a: 6, b: 3 });

    expect(spans).toEqual([
      {
        type: 'tool',
        name: 'divide',
        input: { a: 6, b: 3 },
        ends: [{ output: { result: 2 }, error: undefined }],
      },
    ]);
  });

  test('ends the span with the typed error on failure', async () => {
    const { scope, spans } = fakeTraceScope();
    const bound = divide.bind({ layers: {}, tracing: scope });

    await expect(bound.execute({ a: 1, b: 0 })).rejects.toBeInstanceOf(ToolExecutionError);
    await bound.executeForModel({ a: 'x', b: 0 });

    expect(spans).toHaveLength(2);
    expect(spans[0]?.ends).toEqual([{ output: undefined, error: expect.any(ToolExecutionError) }]);
    expect(spans[1]?.input).toEqual({ a: 'x', b: 0 });
    expect(spans[1]?.ends).toEqual([{ output: undefined, error: expect.any(ToolInputError) }]);
  });

  test('a failing tracer never fails the tool', async () => {
    const throwingScope: RunTraceScope = {
      runId: 'run-1',
      contextId: 'ctx-1',
      startRun: () => {
        throw new Error('tracer down');
      },
      flush: async () => {},
    };
    const rejectingScope: RunTraceScope = {
      ...throwingScope,
      startRun: () => ({ runId: 'span', end: () => Promise.reject(new Error('export failed')) }),
    };

    await expect(
      divide.bind({ layers: {}, tracing: throwingScope }).execute({ a: 4, b: 2 }),
    ).resolves.toEqual({ result: 2 });
    await expect(
      divide.bind({ layers: {}, tracing: rejectingScope }).execute({ a: 4, b: 2 }),
    ).resolves.toEqual({ result: 2 });
  });

  test('AgentToolCollection threads its tracing scope into the tools', async () => {
    const { scope, spans } = fakeTraceScope();
    const collection = new AgentToolCollection([divide], {}, () => {}, undefined, {
      tracing: scope,
    });

    await collection.toTools()[0]?.execute({ a: 9, b: 3 });

    expect(spans.map((span) => [span.type, span.name])).toEqual([['tool', 'divide']]);
  });

  test('tools called in agent logic are traced under the invocation scope', async () => {
    const { scope, spans } = fakeTraceScope();
    const agent = new Agent<undefined, never, never, never, typeof divide>(
      async ({ tools }) => {
        await tools.toTools()[0]?.execute({ a: 8, b: 2 });
      },
      undefined,
      [],
      [],
      [divide],
    );

    await agent.invoke({ tracing: scope });

    expect(spans).toEqual([
      {
        type: 'tool',
        name: 'divide',
        input: { a: 8, b: 2 },
        ends: [{ output: { result: 4 }, error: undefined }],
      },
    ]);
  });
});
