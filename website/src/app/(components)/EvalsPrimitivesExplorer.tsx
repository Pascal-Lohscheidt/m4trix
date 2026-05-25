'use client';

import {
  ChartBarIcon,
  ChartLineUpIcon,
  FlaskIcon,
  GearIcon,
  ListChecksIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import ConceptExplorer, { type ConceptItem } from './ConceptExplorer';

const EVALS_PRIMITIVES: ConceptItem[] = [
  {
    id: 'dataset',
    icon: ChartBarIcon,
    label: 'Dataset',
    headline: 'Named slices of your test cases',
    body: (
      <>
        A Dataset is a tagged collection of test cases — filter by tag, path, or structured
        expression. Run only the <code className="inline-code text-[11px]">&apos;edge&apos;</code>{' '}
        tag before a hotfix. Run the full suite before a release. Same eval files, different scope —
        no duplication.
      </>
    ),
    bullets: [
      'Filter cases by included or excluded tags',
      'Compose AND/OR tag filters with TagAndFilter and TagOrFilter',
      'Scope runs without copying test case files',
    ],
    code: {
      filename: 'edge-cases.dataset.ts',
      language: 'typescript',
      source: `import { Dataset, TagAndFilter, TagOrFilter } from '@m4trix/evals';

export const edgeCasesDataset = Dataset.define({
  name: 'edge-cases',
  displayName: 'Core fast or slow cases',
  includedTags: TagAndFilter.of([
    TagOrFilter.of(['core', 'fast']),
    TagOrFilter.of(['core', 'slow']),
  ]),
  excludedTags: ['deprecated'],
});`,
    },
  },
  {
    id: 'evaluator',
    icon: FlaskIcon,
    label: 'Evaluator',
    headline: 'Typed scoring functions with full context',
    body: (
      <>
        An Evaluator is a typed async function that scores agent output. It receives the current run
        ID, repetition index, and timing in <code className="inline-code text-[11px]">meta</code> —
        no global state, no thread locals.
      </>
    ),
    bullets: [
      'Typed input, output, and score schemas on every evaluator',
      'Middleware injects dependencies like LLM clients or loggers',
      'Returns scores and metrics — diff logging built in',
    ],
    code: {
      filename: 'score.evaluator.ts',
      language: 'typescript',
      source: `import { Evaluator, latencyMetric, percentScore, S } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({ expectedMinScore: S.Number });

export const scoreEvaluator = Evaluator.use({
  name: 'withSeed',
  resolve: () => ({ seed: 7 }),
})
  .define({
    name: 'score-evaluator',
    displayName: 'Prompt score',
    inputSchema,
    outputSchema,
    scoreSchema: S.Struct({ scores: S.Array(S.Unknown) }),
  })
  .evaluate(async ({ input, output, meta }) => {
    const start = Date.now();
    const value = Math.min(100, input.prompt.length * 2 + meta.repetitionIndex);

    return {
      scores: [
        percentScore.make(
          { value },
          {
            definePassed: (d) =>
              d.value >= (output?.expectedMinScore ?? 50),
          },
        ),
      ],
      metrics: [latencyMetric.make({ ms: Date.now() - start })],
    };
  });`,
    },
  },
  {
    id: 'test-cases',
    icon: ListChecksIcon,
    label: 'Test Cases',
    headline: 'Stable named inputs that outlive any evaluator',
    body: (
      <>
        Test cases are named inputs with tags. The same{' '}
        <code className="inline-code text-[11px]">&apos;ambiguous-question&apos;</code> case feeds
        five different evaluators. Add a new evaluator next month and it picks up all existing cases
        automatically.
      </>
    ),
    bullets: [
      'One case definition, many evaluators',
      'Optional expected output for diff-based scoring',
      'Version-controlled alongside your agent code',
    ],
    code: {
      filename: 'ambiguous-question.test-case.ts',
      language: 'typescript',
      source: `import { S, TestCase } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({
  expectedMinScore: S.Number,
  expectedResponse: S.optional(S.String),
});

export const ambiguousQuestion = TestCase.describe({
  name: 'ambiguous-question',
  displayName: 'Capital city factual check',
  tags: ['edge', 'core'],
  inputSchema,
  input: { prompt: 'What is the capital of France?' },
  outputSchema,
  output: {
    expectedMinScore: 50,
    expectedResponse: 'The capital of France is Paris.',
  },
});`,
    },
  },
  {
    id: 'run-config',
    icon: GearIcon,
    label: 'Run Config',
    headline: 'Wire datasets to evaluators and control execution',
    body: (
      <>
        A RunConfig connects Datasets to their Evaluators. Set{' '}
        <code className="inline-code text-[11px]">repetitions: 5</code> to measure variance. Set a{' '}
        <code className="inline-code text-[11px]">seed</code> to make sampling reproducible across
        runs. The RunConfig is what the CLI actually executes.
      </>
    ),
    bullets: [
      'Control repetition, sampling, and concurrency per row',
      'Select evaluators by instance or wildcard pattern',
      'Reproducible runs with explicit seeds',
    ],
    code: {
      filename: 'nightly.run-config.ts',
      language: 'typescript',
      source: `import { RunConfig } from '@m4trix/evals';
import { edgeCasesDataset } from './edge-cases.dataset.js';
import { scoreEvaluator } from './score.evaluator.js';

export const nightlyRunConfig = RunConfig.define({
  name: 'nightly',
  displayName: 'Nightly regression',
  tags: ['ci'],
  runs: [
    {
      dataset: edgeCasesDataset,
      evaluators: [scoreEvaluator],
      repetitions: 5,
      sampling: { percent: 25, seed: 'nightly-2025' },
    },
    { dataset: edgeCasesDataset, evaluatorPattern: '*score*' },
  ],
});`,
    },
  },
  {
    id: 'metrics',
    icon: ChartLineUpIcon,
    label: 'Metrics',
    headline: 'Built-in and custom metrics with aggregation',
    body: (
      <>
        <code className="inline-code text-[11px]">latencyMetric</code> and{' '}
        <code className="inline-code text-[11px]">tokenCountMetric</code> ship out of the box.
        Defining a custom one is three lines: an <code className="inline-code text-[11px]">id</code>
        , a <code className="inline-code text-[11px]">format</code> function, and an optional{' '}
        <code className="inline-code text-[11px]">aggregate</code>. Results roll up across
        repetitions automatically.
      </>
    ),
    bullets: [
      'Latency and token metrics included by default',
      'Custom metrics with format and aggregate functions',
      'Automatic rollup across repetitions',
    ],
    code: {
      filename: 'metrics.ts',
      language: 'typescript',
      source: `import { Metric, latencyMetric, tokenCountMetric } from '@m4trix/evals';

export const modelLatencyMetric = Metric.of<{ ms: number }>({
  id: 'model-latency',
  name: 'Model latency',
  format: (data) => \`\${data.ms}ms\`,
  aggregate: (values) => ({
    ms: values.reduce((sum, v) => sum + v.ms, 0) / values.length,
  }),
});

// Built-ins — return from any evaluator:
latencyMetric.make({ ms: 142 });
tokenCountMetric.make({ input: 120, output: 48 });`,
    },
  },
  {
    id: 'cli',
    icon: TerminalWindowIcon,
    label: 'CLI Runner',
    headline: 'File-based discovery — zero registration boilerplate',
    body: (
      <>
        Drop files under <code className="inline-code text-[11px]">src/evals/</code>. The runner
        finds <code className="inline-code text-[11px]">*.dataset.ts</code>,{' '}
        <code className="inline-code text-[11px]">*.evaluator.ts</code>, and{' '}
        <code className="inline-code text-[11px]">*.run-config.ts</code>, builds the execution plan,
        and reports. No registration file beyond an optional config.
      </>
    ),
    bullets: [
      'Convention-based file discovery like Vitest',
      'Same command locally and in CI with --ci exit codes',
      'Artifacts land in .eval-results for sinks and dashboards',
    ],
    code: {
      filename: 'Terminal',
      language: 'bash',
      source: `# optional config: m4trix-eval.config.ts
pnpm m4trix-evals run \\
  --run-config nightly \\
  --concurrency 4 \\
  --experiment-name "prompt-v3" \\
  --ci`,
    },
  },
];

export default function EvalsPrimitivesExplorer() {
  return (
    <ConceptExplorer
      items={EVALS_PRIMITIVES}
      ariaLabel="Eval primitives"
      idPrefix="eval-primitive"
    />
  );
}
