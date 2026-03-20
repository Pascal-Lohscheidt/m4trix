[![CircleCI](https://dl.circleci.com/status-badge/img/gh/Pascal-Lohscheidt/m4trix/tree/main.svg?style=svg)](https://dl.circleci.com/status-badge/redirect/gh/Pascal-Lohscheidt/m4trix/tree/main)
[![npm version](https://img.shields.io/npm/v/@m4trix%2Fevals)](https://www.npmjs.com/package/@m4trix/evals)
[![npm downloads](https://img.shields.io/npm/dm/@m4trix%2Fevals)](https://www.npmjs.com/package/@m4trix/evals)
[![license](https://img.shields.io/npm/l/@m4trix%2Fevals)](https://www.npmjs.com/package/@m4trix/evals)

# @m4trix/evals

`@m4trix/evals` helps you define datasets, test cases, and evaluators for repeatable AI evaluation runs.

## Quick Start

From the repository root:

```bash
pnpm install
pnpm run evals:build
```

Run the bundled example project:

```bash
cd examples/evals-example
pnpm run eval:run
```

Generate a dataset case file from the example:

```bash
pnpm run eval:generate
```

## Set Up Your First Eval

Create files under your project (for example, `src/evals/`) with these suffixes:

- `*.dataset.ts`
- `*.evaluator.ts`
- `*.run-config.ts`
- `*.test-case.ts`

Optional: create `m4trix-eval.config.ts` at your project root to customize discovery and output paths.

```ts
import { defineConfig, type ConfigType } from '@m4trix/evals';

export default defineConfig((): ConfigType => ({
  discovery: {
    rootDir: 'src/evals',
    datasetFilePatterns: ['.dataset.ts'],
    evaluatorFilePatterns: ['.evaluator.ts'],
    runConfigFilePatterns: ['.run-config.ts'],
    testCaseFilePatterns: ['.test-case.ts'],
    excludeDirectories: ['node_modules', 'dist'],
  },
  artifactDirectory: 'src/evals/.eval-results',
}));
```

### 1) Dataset

```ts
import { Dataset } from '@m4trix/evals';

export const myDataset = Dataset.define({
  name: 'my-dataset',
  displayName: 'My Dataset',
  includedTags: ['demo'],
});
```

### 2) Evaluator

```ts
import { Evaluator, S, latencyMetric, percentScore, tokenCountMetric } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });

export const myEvaluator = Evaluator.define({
  name: 'My Evaluator',
  inputSchema,
  outputSchema: S.Unknown,
  scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
  // optional: tags: ['suite-a'],
}).evaluate(async ({ input, ctx: _ctx, output, createError }) => {
  const start = Date.now();
  const value = 85;
  if (value < 50) {
    return createError(
      { reason: 'score below minimum', value, prompt: input.prompt, output },
      { label: 'quality-check' },
    );
  }
  const latencyMs = Date.now() - start;
  const minScore =
    typeof output === 'object' &&
    output !== null &&
    'expectedMinScore' in output
      ? (output as { expectedMinScore?: number }).expectedMinScore
      : undefined;

  return {
    scores: [
      percentScore.make(
        { value },
        { definePassed: (d) => d.value >= (minScore ?? 50) },
      ),
    ],
    metrics: [
      tokenCountMetric.make({
        input: input.prompt.length,
        output: input.prompt.length,
        inputCached: 0,
        outputCached: 0,
      }),
      latencyMetric.make({ ms: latencyMs }),
    ],
  };
});
```

### 3) Test Case

```ts
import { TestCase, S } from '@m4trix/evals';

export const myTestCase = TestCase.describe({
  name: 'my test case',
  tags: ['demo'],
  inputSchema: S.Struct({ prompt: S.String }),
  input: { prompt: 'Hello from my first eval' },
  outputSchema: S.Struct({ expectedMinScore: S.Number }),
  output: { expectedMinScore: 50 },
});
```

`tags` is optional; omit it when the test case has no declared labels. Evaluators read them as `meta.testCaseTags`.

### 4) RunConfig (optional)

Group several dataset/evaluator runs under one named config. Each row is either
`evaluators: [...]` (same module instances discovery loads) or `evaluatorPattern: "..."`
(wildcard / regex rules from `RunnerApi.resolveEvaluatorsByNamePattern`). Multiple jobs share one `--concurrency` cap.

Optional **`repetitions`** on a row (default `1`) runs each matching test case that many times. Every execution in that group shares the same **`repetitionId`** in the evaluator callback **`meta`**, with **`repetitionIndex`** / **`repetitionCount`**. Evaluator **`meta`** includes **`datasetName`** (`Dataset.getDisplayLabel()` → `displayName ?? name`), **`runConfigName`** (the **`RunConfig`** id or **`programmatic`** from **`PROGRAMMATIC_RUN_CONFIG`** for API/TUI-only **`runDatasetWith`**), optional **`experimentName`**, and declared tag lists **`testCaseTags`**, **`runConfigTags`**, and **`evaluatorTags`** (empty arrays when unset). **`Dataset`** **`includedTags` / `excludedTags`** only filter which test cases belong to a dataset; they are not the same as **`TestCase.describe({ tags })`** or **`Evaluator.define({ tags })`**, which label the case/evaluator and show up in **`meta`**. **`Dataset`** and **`TestCase`** follow the same naming convention as **`RunConfig`**: **`name`** is the stable id; optional **`displayName`** is unrestricted for UI. Names may use **kebab-case**, **snake_case**, **camelCase**, etc. (letters, digits, `_`, `-` only, no spaces); resolution is **case-insensitive**.

```ts
import { RunConfig } from '@m4trix/evals';
import { myDataset } from './my.dataset';
import { myEvaluator } from './my.evaluator';

export const nightly = RunConfig.define({
  name: 'nightly',
  runs: [
    { dataset: myDataset, evaluators: [myEvaluator], repetitions: 3 },
    { dataset: myDataset, evaluatorPattern: '*smoke*' },
  ],
});
```

### 5) Run

```bash
eval-agents-simple run --run-config "nightly"
```

Repeat **`--run-config`** to queue several configs; jobs share one **`--concurrency`** cap. Use **`--experiment <name>`** to set **`meta.experimentName`** for every evaluator in that CLI run (any non-empty string; trimmed).

## CLI Commands

- `eval-agents`: interactive CLI (starts runs with synthetic meta `programmatic` / `Programmatic`)
- `eval-agents-simple run --run-config "<RunConfig name>"` (repeatable; case-insensitive match); add **`--ci`** to exit with code **1** if any test case fails
- `eval-agents-simple generate --dataset "<dataset id>"` (canonical **`Dataset` `name`**, case-insensitive)

## Default Discovery and Artifacts

By default, the runner uses `process.cwd()` as discovery root and scans for:

- Datasets: `.dataset.ts`, `.dataset.tsx`, `.dataset.js`, `.dataset.mjs`
- Evaluators: `.evaluator.ts`, `.evaluator.tsx`, `.evaluator.js`, `.evaluator.mjs`
- Run configs: `.run-config.ts`, `.run-config.tsx`, `.run-config.js`, `.run-config.mjs`
- Test cases: `.test-case.ts`, `.test-case.tsx`, `.test-case.js`, `.test-case.mjs`

Results are written to `.eval-results`.

## Config File

When present, `m4trix-eval.config.ts` is loaded automatically from `process.cwd()`.

- Config API: `defineConfig(() => ConfigType)`
- Supported exports: default object, or default function that returns config
- Discovery keys:
  - `datasetFilePatterns` (or `datasetSuffixes`)
  - `evaluatorFilePatterns` (or `evaluatorSuffixes`)
  - `runConfigFilePatterns` (or `runConfigSuffixes`)
  - `testCaseFilePatterns` (or `testCaseSuffixes`)
  - `rootDir`, `excludeDirectories`

Precedence is:

1. built-in defaults
2. `m4trix-eval.config.ts`
3. explicit `createRunner({...})` overrides

## License

MIT
