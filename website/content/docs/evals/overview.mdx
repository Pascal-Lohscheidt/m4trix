---
title: "Overview"
---

`@m4trix/evals` helps you build repeatable evaluation suites for AI systems. You describe the cases to run, group them into datasets, attach one or more evaluators, and execute named run configs from the CLI or runner API.

Use it when you want to:

- Keep prompt, agent, or workflow regressions visible over time
- Run the same test cases across several evaluators or scoring strategies
- Store run artifacts for later inspection
- Run evals locally, in CI, or through the interactive terminal UI

## Core Model

An eval suite is made of four pieces:

1. **Test cases** define typed inputs, optional expected outputs, and tags.
2. **Datasets** select test cases by tag and/or file path.
3. **Evaluators** score each selected case and can record metrics, logs, and diffs.
4. **Run configs** queue dataset/evaluator jobs with optional repetitions, sampling, and tags.

```ts
import { Dataset, Evaluator, RunConfig, S, TestCase, percentScore } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({ expectedMinScore: S.Number });

export const smokeDataset = Dataset.define({
  name: 'smoke',
  includedTags: ['smoke'],
});

export const shortAnswerCase = TestCase.describe({
  name: 'short-answer',
  tags: ['smoke'],
  inputSchema,
  input: { prompt: 'Answer in one sentence: what is an eval?' },
  outputSchema,
  output: { expectedMinScore: 70 },
});

export const qualityEvaluator = Evaluator.use({
  name: 'noop',
  resolve: () => ({}),
})
  .define({
    name: 'quality',
    inputSchema,
    outputSchema,
    scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
  })
  .evaluate(async ({ output }) => ({
    scores: [
      percentScore.make(
        { value: 85 },
        { definePassed: (data) => data.value >= (output?.expectedMinScore ?? 50) },
      ),
    ],
  }));

export const smokeRun = RunConfig.define({
  name: 'smoke',
  runs: [{ dataset: smokeDataset, evaluators: [qualityEvaluator] }],
});
```

## Package Exports

Import the builders and helpers from `@m4trix/evals`:

- `Dataset`, `TestCase`, `Evaluator`, `RunConfig`
- `Score`, `Metric`, `percentScore`, `deltaScore`, `binaryScore`
- `tokenCountMetric`, `latencyMetric`
- `TagAndFilter`, `TagOrFilter`, `TagSet`
- `defineConfig`, `createRunner`, `withRunnerConfig`
- `S`, re-exported from Effect Schema

## Example Project

The repository includes a complete example at `examples/evals-example`. It contains dataset, test case, evaluator, run config, sampling, tag filter, and config examples.

Run it from the example directory:

```bash
pnpm install
pnpm run eval:run
```

