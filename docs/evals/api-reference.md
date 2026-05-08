---
title: "API Reference"
---

This page summarizes the main public APIs exported from `@m4trix/evals`.

## Dataset

Use `Dataset.define(...)` to select discovered test cases.

```ts
Dataset.define({
  name: 'smoke',
  displayName: 'Smoke Suite',
  includedTags: ['smoke'],
  excludedTags: ['slow'],
  includedPaths: ['src/evals/**'],
  excludedPaths: ['**/*.skip.test-case.ts'],
});
```

Fields:

- `name`: stable id; letters, digits, `_`, and `-`.
- `displayName`: optional human-facing label.
- `includedTags`: string/RegExp matchers, or `TagOrFilter` / `TagAndFilter` expressions.
- `excludedTags`: string/RegExp matchers.
- `includedPaths`: string glob or RegExp matchers.
- `excludedPaths`: string glob or RegExp matchers.

## TestCase

Use `TestCase.describe(...)` for each case.

```ts
TestCase.describe({
  name: 'pricing-answer',
  displayName: 'Pricing FAQ answer',
  tags: ['faq', 'pricing'],
  inputSchema: S.Struct({ prompt: S.String }),
  input: { prompt: 'How much does the product cost?' },
  outputSchema: S.Struct({ expectedMinScore: S.Number }),
  output: { expectedMinScore: 80 },
});
```

`input` and `output` can be values or functions returning values.

## Evaluator

Use `Evaluator.use(...)` to provide middleware context, then call `.define(...)` and `.evaluate(...)`.

```ts
Evaluator.use({
  name: 'withSearchClient',
  resolve: () => ({ searchClient }),
})
  .define({
    name: 'retrieval-quality',
    displayName: 'Retrieval Quality',
    inputSchema,
    outputSchema,
    scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
    tags: ['retrieval'],
  })
  .evaluate(async ({ input, output, ctx, meta, log, logDiff, createError }) => {
    // return a score object or Error
  });
```

Evaluator callback arguments:

- `input`: resolved test-case input.
- `output`: optional resolved expected output.
- `ctx`: merged middleware context.
- `meta`: run, dataset, test-case, repetition, experiment, and tag metadata.
- `log(...)`: attach a log entry to the artifact.
- `logDiff(...)`: attach an expected-vs-actual diff.
- `createError(...)`: create a structured evaluator error.

## RunConfig

Use `RunConfig.define(...)` to create named runnable suites.

```ts
RunConfig.define({
  name: 'nightly',
  displayName: 'Nightly evals',
  tags: ['nightly'],
  runs: [
    { dataset, evaluators: [qualityEvaluator], repetitions: 3 },
    { dataset, evaluatorPattern: '*safety*' },
    {
      dataset,
      evaluators: [qualityEvaluator],
      sampling: { percent: 25, seed: 'nightly-sample' },
    },
  ],
});
```

Each run row must set either:

- `evaluators`: concrete evaluator exports from discovered modules.
- `evaluatorPattern`: wildcard or regex-style evaluator name pattern resolved by the runner.

Optional row fields:

- `repetitions`: positive integer, defaults to `1`.
- `sampling`: set exactly one of `count` or `percent`; optional `seed`.

## Scores

Built-in scores:

- `percentScore`: `{ value, stdDev?, count? }`
- `deltaScore`: `{ value, delta }`
- `binaryScore`: `{ passed, passedCount?, totalCount? }`

Example:

```ts
percentScore.make(
  { value: 92 },
  { definePassed: (data) => data.value >= 80 },
);
```

Create custom scores with `Score.of(...)`:

```ts
const relevanceScore = Score.of<{ value: number }>({
  id: 'relevance',
  name: 'Relevance',
  displayStrategy: 'bar',
  formatValue: (data) => data.value.toFixed(2),
  aggregateValues: Score.aggregate.averageFields(['value']),
});
```

## Metrics

Built-in metrics:

- `tokenCountMetric`: `{ input?, output?, inputCached?, outputCached? }`
- `latencyMetric`: `{ ms }`

Create custom metrics with `Metric.of(...)`.

## Runner API

Use `createRunner(...)` when you want to discover and run evals programmatically.

```ts
import { createRunner } from '@m4trix/evals';

const runner = createRunner({
  discovery: { rootDir: 'src/evals' },
  artifactDirectory: '.eval-results',
});

await runner.collectDatasets();
await runner.collectEvaluators();

const dataset = await runner.resolveDatasetByName('smoke');
const evaluators = await runner.resolveEvaluatorsByNamePattern('*quality*');

if (dataset && evaluators.length > 0) {
  await runner.runDatasetWith({
    datasetId: dataset.id,
    evaluatorIds: evaluators.map((item) => item.id),
    runConfigName: 'programmatic',
    concurrency: 2,
  });
}
```

The runner can also expand a discovered `RunConfig` and execute all jobs with shared concurrency.

