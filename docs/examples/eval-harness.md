# Eval Harness

Use `@m4trix/evals` to define datasets, test cases, and evaluators for repeatable AI evaluation runs.

## Location

```
examples/evals-example/
```

## How It Works

1. **Dataset** — Groups test cases by tags and/or file paths
2. **Test Case** — Defines input/output pairs (e.g. prompt + expected score threshold)
3. **Evaluator** — Applies scoring logic to each test case
4. **RunConfig + CLI** — Group dataset/evaluator jobs and execute with `eval-agents-simple run --run-config "..."`

## Setup

```bash
pnpm add @m4trix/evals
```

Create files with suffixes:

- `*.dataset.ts` — Dataset definitions
- `*.evaluator.ts` — Evaluator definitions
- `*.test-case.ts` — Test case definitions
- `*.run-config.ts` — Named multi-job configs

## Run Evals

```bash
eval-agents-simple run --run-config "example-name"
```

Repeat `--run-config` to queue multiple configs; they share one `--concurrency` cap.

RunConfig **names** allow kebab-case, snake_case, camelCase, etc.: only letters, digits, `_`, and `-` (no spaces). The CLI matches names **case-insensitively**.

## Key Files in evals-example

- `src/evals/demo.dataset.ts` — Dataset with `includedTags: ['demo']`
- `src/evals/demo.evaluator.ts` — Evaluators (score, length, multi-score, diff)
- `src/evals/demo.test-case.ts` — Test cases with prompts and expected outputs
- `src/evals/example-name.run-config.ts` — Example `RunConfig`
- `m4trix-eval.config.ts` — Discovery and artifact paths

## Config

Optional `m4trix-eval.config.ts` at project root:

```ts
import { defineConfig, type ConfigType } from '@m4trix/evals';

export default defineConfig((): ConfigType => ({
  discovery: {
    rootDir: 'src/evals',
    datasetFilePatterns: ['.dataset.ts'],
    evaluatorFilePatterns: ['.evaluator.ts'],
    testCaseFilePatterns: ['.test-case.ts'],
    excludeDirectories: ['node_modules', 'dist'],
  },
  artifactDirectory: 'src/evals/.eval-results',
}));
```

## Next

- [Testing Guide](../guides/testing.md)
- [@m4trix/evals](https://github.com/Pascal-Lohscheidt/m4trix) package docs
