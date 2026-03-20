import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vitest } from 'vitest';
import { type EvalMiddleware, Evaluator, getEvaluatorDisplayLabel } from './evaluator';

describe('Evaluator', () => {
  const inputSchema = S.Struct({ prompt: S.String });
  const outputSchema = S.Struct({ title: S.String });
  const scoreSchema = S.Struct({ accuracy: S.Number });

  const withLLM: EvalMiddleware<{ llm: string }> = {
    name: 'withLLM',
    resolve: () => ({ llm: 'mock-llm-client' }),
  };

  const withLogger: EvalMiddleware<{ log: (msg: string) => void }> = {
    name: 'withLogger',
    resolve: () => ({ log: () => {} }),
  };

  test('use() -> define() -> evaluate() creates a fully configured evaluator', () => {
    const evaluator = Evaluator.use(withLLM)
      .define({
        name: 'title-quality',
        displayName: 'Title quality',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(({ ctx: { llm } }) => {
        return { accuracy: llm === 'mock-llm-client' ? 100 : 0 };
      });

    expect(evaluator.getName()).toBe('title-quality');
    expect(evaluator.getDisplayLabel()).toBe('Title quality');
    expect(evaluator.getMiddlewares()).toHaveLength(1);
    expect(evaluator.getEvaluateFn()).toBeDefined();
  });

  test('chaining multiple use() calls accumulates middlewares', () => {
    const evaluator = Evaluator.use(withLLM).use(withLogger).define({
      name: 'multi-context',
      inputSchema,
      outputSchema,
      scoreSchema,
    });

    expect(evaluator.getMiddlewares()).toHaveLength(2);
    expect(evaluator.getMiddlewares()[0].name).toBe('withLLM');
    expect(evaluator.getMiddlewares()[1].name).toBe('withLogger');
  });

  test('each method returns a new instance (immutable)', () => {
    const step1 = Evaluator.use(withLLM);
    const step2 = step1.define({
      name: 'step-2',
      inputSchema,
      outputSchema,
      scoreSchema,
    });
    const step3 = step2.evaluate((_args) => ({ accuracy: 50 }));

    expect(step1).not.toBe(step2);
    expect(step2).not.toBe(step3);
    expect(step1.getName()).toBeUndefined();
    expect(step2.getName()).toBe('step-2');
    expect(step2.getEvaluateFn()).toBeUndefined();
    expect(step3.getEvaluateFn()).toBeDefined();
  });

  test('resolveContext() merges middleware results', async () => {
    const evaluator = Evaluator.use(withLLM).use(withLogger).define({
      name: 'context-test',
      inputSchema,
      outputSchema,
      scoreSchema,
    });

    const ctx = await evaluator.resolveContext();
    expect(ctx).toHaveProperty('llm', 'mock-llm-client');
    expect(ctx).toHaveProperty('log');
    expect(typeof ctx.log).toBe('function');
  });

  test('resolveContext() handles async middleware', async () => {
    const asyncMw: EvalMiddleware<{ token: string }> = {
      name: 'asyncAuth',
      resolve: async () => {
        return { token: 'abc-123' };
      },
    };

    const evaluator = Evaluator.use(asyncMw).define({
      name: 'async-test',
      inputSchema,
      outputSchema,
      scoreSchema,
    });

    const ctx = await evaluator.resolveContext();
    expect(ctx).toHaveProperty('token', 'abc-123');
  });

  test('evaluate function receives { input, ctx, output, meta }', async () => {
    const evalFn = vitest.fn(
      ({
        input,
        ctx,
        output,
      }: {
        input: { prompt: string };
        ctx: { llm: string };
        output?: unknown;
      }) => {
        void output;
        return {
          accuracy: input.prompt.length + (ctx.llm === 'mock-llm-client' ? 1 : 0),
        };
      },
    );

    const evaluator = Evaluator.use(withLLM)
      .define({
        name: 'fn-test',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(evalFn);

    const fn = evaluator.getEvaluateFn()!;
    const ctx = await evaluator.resolveContext();
    const logDiff = () => {};
    const log = () => {};
    const createError = () => {
      return new Error('failed');
    };
    const result = await fn({
      input: { prompt: 'hello' },
      ctx,
      output: { title: 'value' },
      meta: {
        triggerId: 'trg-123',
        runId: 'run-123',
        datasetName: 'fixture-dataset',
        testCaseId: 'tc-fixture',
        testCaseName: 'Fixture case',
        runConfigName: 'test-rc',
        repetitionId: 'rep-test',
        repetitionIndex: 1,
        repetitionCount: 1,
        testCaseTags: ['tc-a'],
        runConfigTags: ['rc-x'],
        evaluatorTags: [],
      },
      logDiff,
      log,
      createError,
    });

    expect(evalFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { prompt: 'hello' },
        ctx,
        output: { title: 'value' },
        meta: expect.objectContaining({
          testCaseTags: ['tc-a'],
          runConfigTags: ['rc-x'],
          evaluatorTags: [],
        }),
      }),
    );
    expect(result).toEqual({ accuracy: 6 });
  });

  test('exposes schemas through accessors', () => {
    const evaluator = Evaluator.use(withLLM).define({
      name: 'schema-test',
      inputSchema,
      outputSchema,
      scoreSchema,
    });

    expect(evaluator.getInputSchema()).toBe(inputSchema);
    expect(evaluator.getOutputSchema()).toBe(outputSchema);
    expect(evaluator.getScoreSchema()).toBe(scoreSchema);
  });

  test('evaluate callback receives typed input and merged context', () => {
    const evaluator = Evaluator.use(withLLM)
      .use(withLogger)
      .define({
        name: 'typed-context',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(({ input, ctx }) => {
        expectTypeOf(input).toEqualTypeOf(inputSchema.Type);
        expectTypeOf(ctx).toHaveProperty('llm');
        expectTypeOf(ctx).toHaveProperty('log');
        expectTypeOf(ctx.llm).toEqualTypeOf<string>();
        return {
          accuracy: input.prompt.length + (ctx.llm === 'ok' ? 1 : 0),
        };
      });
    expect(evaluator).toBeDefined();
  });

  test('evaluate callback receives typed output from outputSchema', () => {
    const typedOutputSchema = S.Struct({ expectedMinScore: S.Number });
    Evaluator.use(withLLM)
      .define({
        name: 'typed-output',
        inputSchema,
        outputSchema: typedOutputSchema,
        scoreSchema,
      })
      .evaluate(({ input, output }) => {
        expectTypeOf(output!).toEqualTypeOf(typedOutputSchema.Type);
        const minScore = output?.expectedMinScore ?? 0;
        return { accuracy: input.prompt.length + minScore };
      });
  });

  test('evaluate callback return must match scoreSchema', () => {
    Evaluator.use(withLLM)
      .define({
        name: 'typed-return',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(({ input }) => {
        const result = {
          accuracy: input.prompt.length,
        };
        return result;
      });

    Evaluator.use(withLLM)
      .define({
        name: 'typed-return',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      // @ts-expect-error - we want to test the type error
      .evaluate(() => {
        const result = {
          accuracy: 'string',
        };
        return result;
      });
  });

  test('passThreshold is stored and exposed', () => {
    const evaluator = Evaluator.use(withLLM).define({
      name: 'threshold-test',
      inputSchema,
      outputSchema,
      scoreSchema,
      passThreshold: 80,
    });

    expect(evaluator.getPassThreshold()).toBe(80);
    expect(evaluator.getPassCriterion()).toBeUndefined();
  });

  test('passCriterion is stored and exposed', () => {
    const customCriterion = (score: unknown) =>
      typeof score === 'object' &&
      score !== null &&
      'accuracy' in score &&
      (score as { accuracy: number }).accuracy >= 70;

    const evaluator = Evaluator.use(withLLM).define({
      name: 'criterion-test',
      inputSchema,
      outputSchema,
      scoreSchema,
      passCriterion: customCriterion,
    });

    expect(evaluator.getPassThreshold()).toBeUndefined();
    expect(evaluator.getPassCriterion()).toBe(customCriterion);
  });

  test('define() stores tags for getTags() and evaluate-time tag lists', () => {
    const ev = Evaluator.use(withLLM).define({
      name: 'tagged-eval',
      tags: ['eval-suite', 'nightly'],
      inputSchema,
      outputSchema,
      scoreSchema,
    });
    expect(ev.getTags()).toEqual(['eval-suite', 'nightly']);
  });

  test('getEvaluatorDisplayLabel supports class and plain objects', () => {
    const ev = Evaluator.use(withLLM).define({
      name: 'plain-shape',
      displayName: 'Nice label',
      inputSchema,
      outputSchema,
      scoreSchema,
    });
    expect(getEvaluatorDisplayLabel(ev)).toBe('Nice label');
    expect(
      getEvaluatorDisplayLabel({
        getDisplayLabel: () => undefined,
        getName: () => 'x',
      }),
    ).toBe('x');
  });
});
