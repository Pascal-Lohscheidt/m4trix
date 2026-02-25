---
title: Evaluator
nextjs:
  metadata:
    title: Evaluator
    description: Define scoring logic for AI evaluation test cases
---

Evaluators define the scoring logic applied to each test case. They receive input, optional output, and return scores and metrics.

## Basic usage

```ts
import {
  Evaluator,
  S,
  Score,
  latencyMetric,
  percentScore,
  tokenCountMetric,
} from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });

export const myEvaluator = Evaluator.define({
  name: 'My Evaluator',
  inputSchema,
  outputSchema: S.Unknown,
  scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
}).evaluate(async ({ input, output, createError }) => {
  const start = Date.now();
  // ... scoring logic ...
  const value = 85;
  if (value < 50) {
    return createError(
      { reason: 'score below minimum', value, prompt: input.prompt, output },
      { label: 'quality-check' },
    );
  }
  const latencyMs = Date.now() - start;

  return {
    scores: [
      percentScore.make({ value }, { definePassed: (d) => d.value >= 50 }),
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

## Custom number scores with delta tracking

For value + delta vs baseline, use the built-in `deltaScore`. For other shapes, use `Score.of(...)` with explicit `formatValue`, `formatAggregate`, and `aggregateValues`.

### Built-in deltaScore

```ts
import { Evaluator, S, deltaScore } from '@m4trix/evals';

// value + delta vs baseline, e.g. quality improvement
deltaScore.make(
  { value: 85, delta: 12 },
  { definePassed: (d) => d.delta >= 0 },
);
```

### Custom shapes with Score.of

When you need fields beyond value/delta (e.g. complexity + deltaFromTarget):

```ts
import { Evaluator, S, Score, deltaScore } from '@m4trix/evals';

const promptComplexityDeltaScore = Score.of<{
  complexity: number;
  deltaFromTarget: number;
}>({
  id: 'prompt-complexity-delta',
  name: 'Prompt Complexity',
  displayStrategy: 'number',
  formatValue: (data) =>
    `${data.complexity.toFixed(2)} (Target delta: ${data.deltaFromTarget >= 0 ? '+' : ''}${data.deltaFromTarget.toFixed(2)})`,
  formatAggregate: (data) =>
    `Avg: ${data.complexity.toFixed(2)} (Target delta: ${data.deltaFromTarget >= 0 ? '+' : ''}${data.deltaFromTarget.toFixed(2)})`,
  aggregateValues: Score.aggregate.averageFields(['complexity', 'deltaFromTarget']),
});

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({ expectedMinScore: S.Number });

export const customDeltaEvaluator = Evaluator.define({
  name: 'Custom Delta Evaluator',
  inputSchema,
  outputSchema,
  scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
}).evaluate(async ({ input, output }) => {
  const value = Math.min(100, input.prompt.length * 3);
  const baseline = Math.max(10, (output?.expectedMinScore ?? 50) - 5);
  const delta = value - baseline;

  const complexity = Math.min(100, input.prompt.split(/\s+/).length * 8);
  const deltaFromTarget = complexity - 40;

  return {
    scores: [
      deltaScore.make({ value, delta }, { definePassed: (d) => d.delta >= 0 }),
      promptComplexityDeltaScore.make({ complexity, deltaFromTarget }),
    ],
    metrics: [],
  };
});
```

### Aggregate helpers

| Helper | Use case |
|--------|----------|
| `Score.aggregate.averageFields(['a','b'])` | Average numeric fields (e.g. value, delta) |
| `Score.aggregate.averageWithVariance(['value'])` | Average selected fields, and include mean ± std dev for `value` |
| `Score.aggregate.all` | Binary scores (all runs must pass) |
| `Score.aggregate.last` | No aggregation (take last value) |

### Custom aggregation logic

For fully custom aggregation, pass a function:

```ts
aggregateValues: (values) => {
  const count = values.length || 1;
  const avgValue = values.reduce((s, v) => s + v.value, 0) / count;
  const weightedDelta = values.reduce((s, v, i) => s + v.delta * (i + 1), 0) /
    values.reduce((s, _, i) => s + (i + 1), 0);
  return { value: avgValue, delta: weightedDelta };
},
```

## API

### `Evaluator.define(config)`

Defines an evaluator with typed schemas:

| Property | Description |
|----------|-------------|
| `name` | Display name for the evaluator |
| `inputSchema` | Effect schema for test case input |
| `outputSchema` | Effect schema for test case output (optional) |
| `scoreSchema` | Effect schema for the returned score object |

### `.evaluate(fn)`

Attaches the scoring function. The function receives:

- `input` — Validated test case input
- `output` — Validated test case output (if defined)
- `ctx` — Resolved context from middlewares (if any)
- `logDiff` — Callback to record expected vs actual diffs (stored in run artifact, shown by CLI)
- `log` — Callback to log messages or objects (stored in run artifact, shown by CLI)
- `createError` — Callback to build an `Error` from string/object payloads for `return createError(...)`

It must return an object with:

- `scores` — Array of score items (e.g. from `percentScore.make`, `binaryScore.make`)
- `metrics` — Array of metric items (e.g. from `tokenCountMetric.make`, `latencyMetric.make`)

## Middleware (context)

Use `Evaluator.use({ name, resolve })` to inject context (e.g. seed, API keys):

```ts
export const demoScoreEvaluator = Evaluator.use({
  name: 'withSeed',
  resolve: () => ({ seed: 7 }),
})
  .define({
    name: 'Demo Score Evaluator',
    inputSchema,
    outputSchema: S.Unknown,
    scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
  })
  .evaluate(async ({ input, ctx, output }) => {
    // ctx.seed is available
    const rawScore = (promptHash + input.prompt.length * ctx.seed) % 101;
    // ...
  });
```

## Showing expected vs actual with logDiff

Use `logDiff` (passed to your evaluate function) to record diffs between expected and actual output. Diffs are stored in the run artifact (JSONL) and displayed by the eval CLI for failed evaluators:

```ts
import { Evaluator, S, percentScore } from '@m4trix/evals';

const outputSchema = S.Struct({ expectedResponse: S.String });

export const diffEvaluator = Evaluator.use({
  name: 'noop',
  resolve: () => ({}),
})
  .define({
    name: 'Diff Evaluator',
    inputSchema: S.Struct({ prompt: S.String }),
    outputSchema,
    scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
  })
  .evaluate(async ({ input, output, logDiff }) => {
    const expected = output?.expectedResponse;
    const actual = await fetchModelOutput(input.prompt); // Your LLM/system call

    const matches = actual === expected;
    if (!matches && expected) {
      logDiff(expected, actual);
    }

    return {
      scores: [
        percentScore.make(
          { value: matches ? 100 : 0 },
          { definePassed: (d) => d.value >= 80 },
        ),
      ],
      metrics: [],
    };
  });
```

`logDiff(expected, actual, options?)` accepts objects or strings. The diff uses [json-diff](https://www.npmjs.com/package/json-diff), so object property order is ignored—only actual value differences are shown. The diff is stored as plain text in the run artifact.

You can customize the diff via options:

```ts
logDiff(expected, actual, { label: 'response', sort: true });
```

| Option | Description |
|--------|-------------|
| `label` | Label for the diff entry |
| `sort` | Sort array elements before comparing |
| `full` | Include unchanged sections, not just deltas |
| `keysOnly` | Compare only keys, ignore values |
| `outputKeys` | Always show these keys when parent has changes |
| `excludeKeys` | Exclude keys from comparison |
| `precision` | Round floats to N decimals before comparing |

For ad-hoc debugging, use `printJsonDiff` from `@m4trix/evals` to print a colorized diff to stdout.

## Logging with log

Use `log` (passed to your evaluate function) to record messages or objects for failed evaluators. Logs are stored in the run artifact and displayed by the CLI alongside diffs:

```ts
.evaluate(async ({ input, output, log, logDiff }) => {
  const result = await fetchModelOutput(input.prompt);
  if (!matches) {
    log({ prompt: input.prompt, result }, { label: 'debug' });
    logDiff(expected, result);
  }
  return { scores: [...] };
});
```

`log(message, options?)` accepts strings or objects (objects are pretty-printed as JSON). Use it to capture context when a test fails.

## Failing fast with createError

Use `createError` (passed to your evaluate function) when you want to fail an evaluator while keeping rich debug context in logs. It accepts strings or objects and returns an `Error` that you can return (or throw):

```ts
.evaluate(async ({ input, createError }) => {
  const result = await fetchModelOutput(input.prompt);
  if (!result.ok) {
    return createError(
      { reason: 'model returned non-ok', prompt: input.prompt, result },
      { label: 'model-error' },
    );
  }
  return { scores: [...], metrics: [] };
});
```

## Item-level label overrides

You can override the display label per item at creation time so rendered output reflects run-specific naming, without redefining the underlying `Metric` or `Score` definition. The item-level `name` wins over the definition-level `name` in all CLI views.

```ts
// Override score label
deltaScore.make({ value, delta }, { name: 'Quality Delta' });

// Override metric label
latencyMetric.make({ ms: latencyMs }, { name: 'Latency (model only)' });
```

Label precedence in rendering: `item.name` → `def.name` → `def.id` / `item.id`.

When aggregating multiple items (e.g. across reruns), the last non-empty item-level `name` is preserved in the aggregated result.

## Built-in scores and metrics

| Score | Description |
|-------|-------------|
| `percentScore` | 0–100 score with optional pass threshold |
| `deltaScore` | Value + delta vs baseline (e.g. quality improvement) |
| `binaryScore` | Pass/fail score |
| `Score.of(...)` | Custom score definitions (e.g. other numeric shapes) |

| Metric | Description |
|--------|-------------|
| `tokenCountMetric` | Input/output token counts |
| `latencyMetric` | Latency in milliseconds |

## Full example

```ts
import {
  Evaluator,
  S,
  latencyMetric,
  percentScore,
  tokenCountMetric,
} from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });

export const demoScoreEvaluator = Evaluator.use({
  name: 'withSeed',
  resolve: () => ({ seed: 7 }),
})
  .define({
    name: 'Demo Score Evaluator',
    inputSchema,
    outputSchema: S.Unknown,
    scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
  })
  .evaluate(async ({ input, ctx, output }) => {
    const start = Date.now();
    const expectedMinScore =
      typeof output === 'object' &&
      output !== null &&
      'expectedMinScore' in output
        ? (output as { expectedMinScore?: number }).expectedMinScore
        : undefined;
    const rawScore =
      (Array.from(input.prompt).reduce((s, c) => s + c.charCodeAt(0), 0) +
        input.prompt.length * ctx.seed) %
      101;
    const value = Math.max(8, Math.min(100, rawScore));
    const latencyMs = Date.now() - start;

    return {
      scores: [
        percentScore.make(
          { value },
          { definePassed: (d) => d.value >= (expectedMinScore ?? 50) },
        ),
      ],
      metrics: [
        tokenCountMetric.make({
          input: input.prompt.length * 2,
          output: Math.floor(input.prompt.length * 1.5),
          inputCached: 0,
          outputCached: 0,
        }),
        latencyMetric.make({ ms: latencyMs }),
      ],
    };
  });
```
