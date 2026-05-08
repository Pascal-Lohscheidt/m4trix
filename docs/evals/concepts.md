---
title: "Concepts"
---

Evals are discovered from exported builder objects. The runner scans your configured directory, collects `Dataset`, `TestCase`, `Evaluator`, and `RunConfig` exports, then expands each run config into executable jobs.

## Naming

`Dataset`, `TestCase`, `Evaluator`, and `RunConfig` all use `name` as a stable id. Names may contain letters, digits, `_`, and `-`; they cannot contain spaces. CLI resolution is case-insensitive.

Use `displayName` when you want a richer label in the terminal UI or artifacts.

```ts
Dataset.define({
  name: 'checkout_smoke',
  displayName: 'Checkout Smoke Suite',
});
```

## Tags and Dataset Filters

Test-case tags label a case:

```ts
TestCase.describe({
  name: 'refund-policy',
  tags: ['support', 'policy'],
  // ...
});
```

Dataset filters decide which discovered cases belong to a dataset:

```ts
Dataset.define({
  name: 'support',
  includedTags: ['support'],
  excludedTags: ['slow'],
});
```

`includedTags` can be a flat list of string or `RegExp` matchers, or a structured filter:

```ts
import { Dataset, TagAndFilter, TagOrFilter } from '@m4trix/evals';

export const dataset = Dataset.define({
  name: 'support-fast-or-critical',
  includedTags: TagOrFilter.of([
    TagAndFilter.of(['support', 'fast']),
    'critical',
  ]),
});
```

Datasets can also match files:

```ts
Dataset.define({
  name: 'checkout',
  includedPaths: ['src/evals/checkout/**'],
  excludedPaths: ['**/*.slow.test-case.ts'],
});
```

## Evaluator Context

Use `Evaluator.use(...)` to add middleware context. Middleware resolves once per evaluator invocation and is merged into `ctx`.

```ts
export const evaluator = Evaluator.use({
  name: 'withClient',
  resolve: () => ({ client: createModelClient() }),
})
  .define({
    name: 'answer-quality',
    inputSchema,
    outputSchema,
    scoreSchema,
  })
  .evaluate(async ({ input, ctx }) => {
    const response = await ctx.client.generate(input.prompt);
    // score the response
  });
```

## Evaluator Metadata

Every `evaluate` call receives `meta` with run context:

- `triggerId`, `triggerTimestamp`, and `triggeredAt`
- `runId`, `runConfigName`, and optional `experimentName`
- `datasetName`, `testCaseId`, and `testCaseName`
- `repetitionId`, `repetitionIndex`, and `repetitionCount`
- `testCaseTags`, `runConfigTags`, and `evaluatorTags`

This is useful for logging, model traces, or attaching suite labels to external observability tools.

## Scores and Metrics

Scores decide whether a test case passed. Built-in scores include:

- `percentScore` for 0-100 style quality scores
- `deltaScore` for value plus baseline delta
- `binaryScore` for pass/fail checks

Metrics are extra measurements that do not define pass/fail by themselves. Built-in metrics include:

- `tokenCountMetric`
- `latencyMetric`

You can define custom scores and metrics with `Score.of(...)` and `Metric.of(...)`.

## Logs and Diffs

Evaluators can attach details to the run artifact:

```ts
evaluate(async ({ output, log, logDiff, createError }) => {
  log({ step: 'model-response-started' }, { label: 'debug' });

  if (!output) {
    return createError({ reason: 'missing expected output' }, { label: 'validation' });
  }

  logDiff(output.expected, output.actual, { label: 'expected-vs-actual' });

  return { scores: [binaryScore.make({ passed: true })] };
});
```

Logs and diffs are persisted with the run artifact and shown by the CLI.

## Repetitions and Sampling

Run config rows can run each matching case more than once:

```ts
RunConfig.define({
  name: 'stability',
  runs: [{ dataset, evaluators: [evaluator], repetitions: 5 }],
});
```

Use `sampling` to run a subset of a dataset:

```ts
RunConfig.define({
  name: 'sampled',
  runs: [
    {
      dataset,
      evaluators: [evaluator],
      sampling: { count: 20, seed: 'fixed-sample' },
    },
  ],
});
```

Set either `count` or `percent`, not both. A `seed` makes the subset deterministic.

