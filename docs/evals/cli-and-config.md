---
title: "CLI and Config"
---

`@m4trix/evals` ships two CLI entry points:

- `eval-agents-simple` for scripted runs and CI.
- `eval-agents` for the interactive terminal UI.

Most automation should use `eval-agents-simple`.

## Run a Config

```bash
eval-agents-simple run --run-config smoke
```

Queue several run configs in one invocation:

```bash
eval-agents-simple run \
  --run-config smoke \
  --run-config nightly \
  --concurrency 4 \
  --experiment "gpt-4.1-baseline" \
  --ci
```

Options:

- `--run-config <name>` selects a discovered `RunConfig` by `name`; repeat it to queue several configs.
- `--concurrency, -c N` caps concurrent test-case executions. The simple CLI defaults to `4`.
- `--experiment <name>` forwards the label to evaluator `meta.experimentName`.
- `--ci` exits with code `1` if any test case fails.

Run config names are matched case-insensitively.

## Generate Dataset Cases

```bash
eval-agents-simple generate --dataset smoke
```

The dataset name is the canonical `Dataset.define({ name })` id. This command resolves the dataset and generates a case file from the matching discovered cases.

## Interactive UI

```bash
eval-agents
```

The interactive CLI discovers datasets, evaluators, and prior runs, then lets you start and inspect runs from a terminal UI.

## Config File

Create `m4trix-eval.config.ts` in the project root to customize discovery, artifacts, and default runner concurrency.

```ts
import { defineConfig, type ConfigType } from '@m4trix/evals';

export default defineConfig(
  (): ConfigType => ({
    discovery: {
      rootDir: 'src/evals',
      datasetFilePatterns: ['.dataset.ts'],
      evaluatorFilePatterns: ['.evaluator.ts'],
      runConfigFilePatterns: ['.run-config.ts'],
      testCaseFilePatterns: ['.test-case.ts'],
      excludeDirectories: ['node_modules', 'dist'],
    },
    artifactDirectory: 'src/evals/.eval-results',
    maxConcurrency: 2,
  }),
);
```

The config can be a default object or a default function returning the config.

## Default Discovery

Without a config file, discovery starts at `process.cwd()` and scans for:

- Datasets: `.dataset.ts`, `.dataset.tsx`, `.dataset.js`, `.dataset.mjs`
- Evaluators: `.evaluator.ts`, `.evaluator.tsx`, `.evaluator.js`, `.evaluator.mjs`
- Run configs: `.run-config.ts`, `.run-config.tsx`, `.run-config.js`, `.run-config.mjs`
- Test cases: `.test-case.ts`, `.test-case.tsx`, `.test-case.js`, `.test-case.mjs`

Default excluded directories:

- `node_modules`
- `dist`
- `.next`
- `.git`
- `.pnpm-store`

## Artifacts

Run results are written to `.eval-results` by default. Each run snapshot includes:

- run id, status, timestamps, and artifact path
- dataset id and display name
- evaluator ids
- total, completed, passed, and failed test-case counts
- per-test-case scores, metrics, logs, diffs, and errors

Set `artifactDirectory` in `m4trix-eval.config.ts` when you want artifacts colocated with your eval files or persisted by CI.

## Config Precedence

Runner settings are applied in this order:

1. Built-in defaults
2. `m4trix-eval.config.ts`
3. Explicit `createRunner({...})` overrides

