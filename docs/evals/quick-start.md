---
title: "Quick Start"
---

Install the package:

```bash
pnpm add @m4trix/evals
```

Create an eval folder in your project:

```bash
mkdir -p src/evals
```

By default, the runner discovers files with these suffixes:

- `*.dataset.ts`
- `*.test-case.ts`
- `*.evaluator.ts`
- `*.run-config.ts`

## Create a Dataset

Datasets do not contain cases directly. They select discovered `TestCase` exports by tags and/or file paths.

```ts
// src/evals/smoke.dataset.ts
import { Dataset } from '@m4trix/evals';

export const smokeDataset = Dataset.define({
  name: 'smoke',
  displayName: 'Smoke Suite',
  includedTags: ['smoke'],
});
```

`name` is the stable id used by discovery and CLI commands. Use `displayName` for a human-facing label.

## Add Test Cases

Test cases provide typed input, optional expected output, and optional tags.

```ts
// src/evals/smoke.test-case.ts
import { S, TestCase } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({ expectedMinScore: S.Number });

export const greetingCase = TestCase.describe({
  name: 'greeting',
  displayName: 'Friendly greeting',
  tags: ['smoke'],
  inputSchema,
  input: { prompt: 'Write a warm one-sentence greeting.' },
  outputSchema,
  output: { expectedMinScore: 70 },
});
```

You can export one case at a time or export an array of `TestCase.describe(...)` results.

## Add an Evaluator

Evaluators receive the resolved case input, optional expected output, middleware context, and run metadata. Return scores and optional metrics.

```ts
// src/evals/quality.evaluator.ts
import { Evaluator, S, latencyMetric, percentScore, tokenCountMetric } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({ expectedMinScore: S.Number });

export const qualityEvaluator = Evaluator.use({
  name: 'withModel',
  resolve: () => ({ model: 'demo-model' }),
})
  .define({
    name: 'quality',
    displayName: 'Quality',
    inputSchema,
    outputSchema,
    scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
    tags: ['smoke'],
  })
  .evaluate(async ({ input, output }) => {
    const startedAt = Date.now();
    const value = Math.min(100, input.prompt.length * 3);

    return {
      scores: [
        percentScore.make(
          { value },
          { definePassed: (data) => data.value >= (output?.expectedMinScore ?? 50) },
        ),
      ],
      metrics: [
        tokenCountMetric.make({ input: input.prompt.length, output: 20 }),
        latencyMetric.make({ ms: Date.now() - startedAt }),
      ],
    };
  });
```

Use `createError(...)` inside `evaluate` when a failed evaluator should include structured error details in the artifact.

## Add a Run Config

Run configs group one or more dataset/evaluator jobs under a stable name.

```ts
// src/evals/smoke.run-config.ts
import { RunConfig } from '@m4trix/evals';
import { smokeDataset } from './smoke.dataset';
import { qualityEvaluator } from './quality.evaluator';

export const smokeRun = RunConfig.define({
  name: 'smoke',
  displayName: 'Smoke evals',
  tags: ['ci'],
  runs: [
    {
      dataset: smokeDataset,
      evaluators: [qualityEvaluator],
      repetitions: 1,
    },
  ],
});
```

## Run It

```bash
eval-agents-simple run --run-config smoke
```

Useful options:

- `--concurrency, -c N` limits concurrent test-case executions.
- `--experiment <name>` adds `meta.experimentName` to every evaluator call.
- `--ci` exits with code `1` when any test case fails.

Results are written to `.eval-results` unless you override the artifact directory.

