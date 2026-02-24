import { describe, expect, test, vitest } from 'vitest';
import { Schema as S } from 'effect';
import { Evaluator, type EvalMiddleware } from './evaluator';

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
        name: 'Title quality',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(({ ctx: { llm } }) => {
        return { accuracy: llm === 'mock-llm-client' ? 100 : 0 };
      });

    expect(evaluator.getName()).toBe('Title quality');
    expect(evaluator.getMiddlewares()).toHaveLength(1);
    expect(evaluator.getEvaluateFn()).toBeDefined();
  });

  test('chaining multiple use() calls accumulates middlewares', () => {
    const evaluator = Evaluator.use(withLLM).use(withLogger).define({
      name: 'Multi-context',
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
      name: 'Step 2',
      inputSchema,
      outputSchema,
      scoreSchema,
    });
    const step3 = step2.evaluate((_args) => ({ accuracy: 50 }));

    expect(step1).not.toBe(step2);
    expect(step2).not.toBe(step3);
    expect(step1.getName()).toBeUndefined();
    expect(step2.getName()).toBe('Step 2');
    expect(step2.getEvaluateFn()).toBeUndefined();
    expect(step3.getEvaluateFn()).toBeDefined();
  });

  test('resolveContext() merges middleware results', async () => {
    const evaluator = Evaluator.use(withLLM).use(withLogger).define({
      name: 'Context test',
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
      name: 'Async test',
      inputSchema,
      outputSchema,
      scoreSchema,
    });

    const ctx = await evaluator.resolveContext();
    expect(ctx).toHaveProperty('token', 'abc-123');
  });

  test('evaluate function receives { input, ctx, output, meta }', async () => {
    const evalFn = vitest.fn(
      ({ input, ctx, output }: { input: { prompt: string }; ctx: { llm: string }; output?: unknown }) => {
        void output;
        return {
          accuracy: input.prompt.length + (ctx.llm === 'mock-llm-client' ? 1 : 0),
        };
      },
    );

    const evaluator = Evaluator.use(withLLM)
      .define({
        name: 'Fn test',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(evalFn);

    const fn = evaluator.getEvaluateFn()!;
    const ctx = await evaluator.resolveContext();
    const logDiff = () => {};
    const log = () => {};
    const result = await fn({
      input: { prompt: 'hello' },
      ctx,
      output: { title: 'value' },
      meta: {
        triggerId: 'trg-123',
        runId: 'run-123',
        datasetId: 'dataset-123',
      },
      logDiff,
      log,
    });

    expect(evalFn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { prompt: 'hello' },
        ctx,
        output: { title: 'value' },
      }),
    );
    expect(result).toEqual({ accuracy: 6 });
  });

  test('exposes schemas through accessors', () => {
    const evaluator = Evaluator.use(withLLM).define({
      name: 'Schema test',
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
        name: 'Typed context',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(({ input, ctx }) => {
        const _input: { prompt: string } = input;
        const _llm: string = ctx.llm;
        const _log: (m: string) => void = ctx.log;
        void _log;
        return { accuracy: _input.prompt.length + (_llm === 'ok' ? 1 : 0) };
      });
    expect(evaluator).toBeDefined();
  });

  test('evaluate callback rejects wrong input type', () => {
    Evaluator.use(withLLM)
      .define({
        name: 'Reject wrong input',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(({ input }) => {
        // @ts-expect-error - input is { prompt: string }, not number
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _: number = input;
        return { accuracy: 0 };
      });
  });

  test('evaluate callback receives typed output from outputSchema', () => {
    const typedOutputSchema = S.Struct({ expectedMinScore: S.Number });
    Evaluator.use(withLLM)
      .define({
        name: 'Typed output',
        inputSchema,
        outputSchema: typedOutputSchema,
        scoreSchema,
      })
      .evaluate(({ input, output }) => {
        // output is inferred as { expectedMinScore: number } | undefined
        const minScore = output?.expectedMinScore ?? 0;
        return { accuracy: input.prompt.length + minScore };
      });
  });

  test('evaluate callback rejects wrong output type', () => {
    const typedOutputSchema = S.Struct({ expectedMinScore: S.Number });
    Evaluator.use(withLLM)
      .define({
        name: 'Reject wrong output',
        inputSchema,
        outputSchema: typedOutputSchema,
        scoreSchema,
      })
      .evaluate(({ output }) => {
        // @ts-expect-error - output.expectedMinScore is number, not string
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _: string = output?.expectedMinScore;
        return { accuracy: 0 };
      });
  });

  test('evaluate callback rejects wrong context property', () => {
    Evaluator.use(withLLM)
      .define({
        name: 'Reject wrong ctx',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      .evaluate(({ ctx }) => {
        // @ts-expect-error - ctx has llm, not nonexistent
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _: string = ctx.nonexistent;
        return { accuracy: 0 };
      });
  });

  test('evaluate callback return must match scoreSchema', () => {
    Evaluator.use(withLLM)
      .define({
        name: 'Reject wrong return',
        inputSchema,
        outputSchema,
        scoreSchema,
      })
      // @ts-expect-error - must return { accuracy: number }, not { wrongKey: number }
      .evaluate((_args) => ({
        wrongKey: 1,
      }));
  });

  test('passThreshold is stored and exposed', () => {
    const evaluator = Evaluator.use(withLLM).define({
      name: 'Threshold test',
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
      name: 'Criterion test',
      inputSchema,
      outputSchema,
      scoreSchema,
      passCriterion: customCriterion,
    });

    expect(evaluator.getPassThreshold()).toBeUndefined();
    expect(evaluator.getPassCriterion()).toBe(customCriterion);
  });
});
