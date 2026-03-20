import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { loadRunnerData } from '../cli/state';
import { createRunner } from './api';
import { PROGRAMMATIC_RUN_CONFIG, type RunnerApi, type RunnerEvent } from './index';

type FixtureExtension = '.mjs' | '.ts';

interface FixtureSuffixes {
  dataset: string;
  evaluator: string;
  testCase: string;
}

function getDefaultFixtureSuffixes(extension: FixtureExtension): FixtureSuffixes {
  return {
    dataset: `.dataset${extension}`,
    evaluator: `.evaluator${extension}`,
    testCase: `.test-case${extension}`,
  };
}

async function createFixtureWorkspace(
  extension: FixtureExtension,
  suffixes: FixtureSuffixes = getDefaultFixtureSuffixes(extension),
): Promise<string> {
  /** Under package root (Vitest cwd); avoid system temp — sandboxed runs cannot read /tmp. */
  const root = await mkdtemp(join(process.cwd(), '.tmp-runner-'));
  const typedStringConst =
    extension === '.ts' ? "const alphaTag: string = 'alpha';" : "const alphaTag = 'alpha';";
  const typedScoreConst =
    extension === '.ts' ? 'const scoreBase: number = 0;' : 'const scoreBase = 0;';
  const typedFirstValueConst =
    extension === '.ts' ? 'const firstValue: number = 10;' : 'const firstValue = 10;';
  const typedSecondValueConst =
    extension === '.ts' ? 'const secondValue: number = 5;' : 'const secondValue = 5;';
  const typedFirstExpectedConst =
    extension === '.ts' ? 'const firstExpected: number = 10;' : 'const firstExpected = 10;';
  const typedSecondExpectedConst =
    extension === '.ts' ? 'const secondExpected: number = 5;' : 'const secondExpected = 5;';

  await writeFile(
    join(root, `alpha${suffixes.dataset}`),
    [
      typedStringConst,
      'export const alphaDataset = {',
      "  getName: () => 'alpha-dataset',",
      '  getDisplayLabel: () => "Alpha Dataset",',
      '  getIncludedTags: () => [],',
      '  getExcludedTags: () => [],',
      '  getIncludedPaths: () => [],',
      '  getExcludedPaths: () => [],',
      '  matchesTestCase: (testCase, _path) => testCase.getTags().includes(alphaTag)',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(root, `score${suffixes.evaluator}`),
    [
      typedScoreConst,
      'export const scoreEvaluator = {',
      "  getName: () => 'Score Evaluator',",
      '  getTags: () => [],',
      '  getInputSchema: () => undefined,',
      '  getOutputSchema: () => undefined,',
      '  getScoreSchema: () => undefined,',
      '  getMiddlewares: () => [],',
      '  getPassThreshold: () => undefined,',
      '  getPassCriterion: () => undefined,',
      '  getEvaluateFn: () => async ({ input, output, meta }) => ({',
      "    scores: [{ id: 'fixture-score', data: { value: scoreBase + input.value + (((output?.expectedValue ?? 0) - input.value) || 0) } }, { id: 'fixture-meta', data: meta }],",
      '    metrics: []',
      '  }),',
      '  resolveContext: async () => ({})',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(root, `one${suffixes.testCase}`),
    [
      typedFirstValueConst,
      typedFirstExpectedConst,
      'export const firstCase = {',
      "  getName: () => 'first',",
      "  getTags: () => ['alpha'],",
      '  getInputSchema: () => undefined,',
      '  getInput: () => ({ value: firstValue }),',
      '  getOutput: () => ({ expectedValue: firstExpected })',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(root, `two${suffixes.testCase}`),
    [
      typedSecondValueConst,
      typedSecondExpectedConst,
      'export const secondCase = {',
      "  getName: () => 'second',",
      "  getTags: () => ['beta'],",
      '  getInputSchema: () => undefined,',
      '  getInput: () => ({ value: secondValue }),',
      '  getOutput: () => ({ expectedValue: secondExpected })',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  return root;
}

const runners: RunnerApi[] = [];
const workspaces: string[] = [];

async function withRunner(
  extension: FixtureExtension = '.mjs',
): Promise<{ root: string; runner: RunnerApi }> {
  const root = await createFixtureWorkspace(extension, getDefaultFixtureSuffixes(extension));
  const runner = createRunner({
    discovery: {
      rootDir: root,
      datasetSuffixes: [`.dataset${extension}`],
      evaluatorSuffixes: [`.evaluator${extension}`],
      testCaseSuffixes: [`.test-case${extension}`],
      excludeDirectories: [],
    },
    artifactDirectory: join(root, 'results'),
  });
  runners.push(runner);
  workspaces.push(root);
  return { root, runner };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (runners.length > 0) {
    const runner = runners.pop();
    if (runner) {
      await runner.shutdown();
    }
  }
  while (workspaces.length > 0) {
    const root = workspaces.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe('runner discovery and execution', () => {
  test('collects datasets/evaluators and supports search', async () => {
    const { runner } = await withRunner();

    const datasets = await runner.collectDatasets();
    const evaluators = await runner.collectEvaluators();
    const allTestCases = await runner.searchTestCases();
    const alphaOnly = await runner.searchTestCases({
      includedTags: ['alpha'],
    });

    expect(datasets).toHaveLength(1);
    expect(evaluators).toHaveLength(1);
    expect(allTestCases).toHaveLength(2);
    expect(alphaOnly).toHaveLength(1);
    expect(alphaOnly[0].testCase.getName()).toBe('first');
  });

  test('runs dataset in background and emits lifecycle events', async () => {
    const { runner } = await withRunner();
    const [dataset] = await runner.collectDatasets();
    const [evaluator] = await runner.collectEvaluators();

    const events: RunnerEvent[] = [];
    const completed = new Promise<RunnerEvent>((resolve) => {
      const unsubscribe = runner.subscribeRunEvents((event) => {
        events.push(event);
        if (event.type === 'RunCompleted') {
          unsubscribe();
          resolve(event);
        }
      });
    });

    const queued = await runner.runDatasetWith({
      datasetId: dataset.id,
      evaluatorIds: [evaluator.id],
      ...PROGRAMMATIC_RUN_CONFIG,
    });

    const done = await completed;
    const snapshot = runner.getRunSnapshot(queued.runId);

    expect(done.type).toBe('RunCompleted');
    expect(snapshot?.status).toBe('completed');
    expect(snapshot?.totalTestCases).toBe(1);
    expect(events.some((event) => event.type === 'RunQueued')).toBe(true);
    expect(events.some((event) => event.type === 'RunStarted')).toBe(true);
    expect(events.some((event) => event.type === 'TestCaseStarted')).toBe(true);
    expect(events.some((event) => event.type === 'TestCaseProgress')).toBe(true);
    const progressEvent = events.find(
      (event): event is Extract<RunnerEvent, { type: 'TestCaseProgress' }> =>
        event.type === 'TestCaseProgress',
    );
    expect(progressEvent?.output).toEqual({ expectedValue: 10 });
    expect(progressEvent?.evaluatorScores[0]?.scores[0]?.data).toEqual({
      value: 10,
    });
    expect(progressEvent?.evaluatorScores[0]?.scores[1]?.data).toEqual(
      expect.objectContaining({
        datasetName: 'Alpha Dataset',
        runConfigName: PROGRAMMATIC_RUN_CONFIG.runConfigName,
        repetitionIndex: 1,
        repetitionCount: 1,
      }),
    );
    expect(dataset.dataset.getName()).toBe('alpha-dataset');
    const meta = progressEvent?.evaluatorScores[0]?.scores[1]?.data as
      | {
          triggerId?: string;
          runId?: string;
          runConfigName?: string;
          repetitionId?: string;
          repetitionIndex?: number;
          repetitionCount?: number;
        }
      | undefined;
    expect(meta?.triggerId).toMatch(/^trg-[0-9a-f-]{36}$/);
    expect(meta?.runId).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(meta?.repetitionId).toMatch(/^rep-[0-9a-f-]{36}$/);
    expect(meta?.repetitionIndex).toBe(1);
    expect(meta?.repetitionCount).toBe(1);
    expect(meta?.runConfigName).toBe(PROGRAMMATIC_RUN_CONFIG.runConfigName);
  });

  test('maps runner discovery into CLI data shape', async () => {
    const { runner } = await withRunner();
    const data = await loadRunnerData(runner);

    expect(data.datasets).toHaveLength(1);
    expect(data.evaluators).toHaveLength(1);
    expect(data.datasets[0].name).toBe('Alpha Dataset');
    expect(data.evaluators[0].name).toBe('Score Evaluator');
  });

  test('resolves dataset/evaluators by names and collects dataset test cases', async () => {
    const { runner } = await withRunner();
    const dataset = await runner.resolveDatasetByName('alpha-dataset');
    const wildcardEvaluators = await runner.resolveEvaluatorsByNamePattern('*Score*');
    const regexEvaluators = await runner.resolveEvaluatorsByNamePattern('/score/i');

    expect(dataset?.dataset.getName()).toBe('alpha-dataset');
    expect(dataset?.dataset.getDisplayLabel()).toBe('Alpha Dataset');
    expect(wildcardEvaluators).toHaveLength(1);
    expect(regexEvaluators).toHaveLength(1);

    const selectedCases = await runner.collectDatasetTestCases(dataset!.id);
    expect(selectedCases).toHaveLength(1);
    expect(selectedCases[0].testCase.getName()).toBe('first');
  });

  test('discovers and executes TypeScript fixture files with JIT loading', async () => {
    const { runner } = await withRunner('.ts');
    const [dataset] = await runner.collectDatasets();
    const [evaluator] = await runner.collectEvaluators();
    const selectedCases = await runner.collectDatasetTestCases(dataset.id);

    expect(selectedCases).toHaveLength(1);

    const done = new Promise<Extract<RunnerEvent, { type: 'RunCompleted' }>>((resolve) => {
      const unsubscribe = runner.subscribeRunEvents((event) => {
        if (event.type === 'RunCompleted') {
          unsubscribe();
          resolve(event);
        }
      });
    });

    await runner.runDatasetWith({
      datasetId: dataset.id,
      evaluatorIds: [evaluator.id],
      ...PROGRAMMATIC_RUN_CONFIG,
    });
    const completed = await done;

    expect(completed.type).toBe('RunCompleted');
    expect(completed.totalTestCases).toBe(1);
  });

  test('loads m4trix-eval.config.ts and applies custom filename patterns', async () => {
    const root = await createFixtureWorkspace('.ts', {
      dataset: '.custom-dataset.ts',
      evaluator: '.custom-evaluator.ts',
      testCase: '.custom-test-case.ts',
    });
    await writeFile(
      join(root, 'm4trix-eval.config.ts'),
      [
        'export default () => ({',
        `  artifactDirectory: ${JSON.stringify(join(root, 'config-results'))},`,
        '  discovery: {',
        `    rootDir: ${JSON.stringify(root)},`,
        "    datasetFilePatterns: ['.custom-dataset.ts'],",
        "    evaluatorFilePatterns: ['.custom-evaluator.ts'],",
        "    testCaseFilePatterns: ['.custom-test-case.ts'],",
        '    excludeDirectories: [],',
        '  },',
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const runner = createRunner();
    runners.push(runner);
    workspaces.push(root);

    const datasets = await runner.collectDatasets();
    const evaluators = await runner.collectEvaluators();
    const testCases = await runner.searchTestCases();

    expect(datasets).toHaveLength(1);
    expect(evaluators).toHaveLength(1);
    expect(testCases).toHaveLength(2);
  });

  test('runs test cases with repetitions concurrently and aggregates pass/fail correctly', async () => {
    const root = await createFixtureWorkspace('.mjs');
    await writeFile(
      join(root, 'one.test-case.mjs'),
      [
        'const firstValue = 10;',
        'const firstExpected = 10;',
        'export const firstCase = {',
        "  getName: () => 'first',",
        "  getTags: () => ['alpha'],",
        '  getInputSchema: () => undefined,',
        '  getInput: () => ({ value: firstValue }),',
        '  getOutput: () => ({ expectedValue: firstExpected })',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const runner = createRunner({
      discovery: {
        rootDir: root,
        datasetSuffixes: ['.dataset.mjs'],
        evaluatorSuffixes: ['.evaluator.mjs'],
        testCaseSuffixes: ['.test-case.mjs'],
        excludeDirectories: [],
      },
      artifactDirectory: join(root, 'results'),
    });
    runners.push(runner);
    workspaces.push(root);

    const [dataset] = await runner.collectDatasets();
    const [evaluator] = await runner.collectEvaluators();

    const events: RunnerEvent[] = [];
    const completed = new Promise<RunnerEvent>((resolve) => {
      const unsubscribe = runner.subscribeRunEvents((event) => {
        events.push(event);
        if (event.type === 'RunCompleted') {
          unsubscribe();
          resolve(event);
        }
      });
    });

    await runner.runDatasetWith({
      datasetId: dataset.id,
      evaluatorIds: [evaluator.id],
      concurrency: 4,
      repetitions: 3,
      ...PROGRAMMATIC_RUN_CONFIG,
    });

    const done = await completed;

    expect(done.type).toBe('RunCompleted');
    const runCompleted = done as Extract<RunnerEvent, { type: 'RunCompleted' }>;
    expect(runCompleted.totalTestCases).toBe(1);
    expect(runCompleted.passedTestCases).toBe(1);
    expect(runCompleted.failedTestCases).toBe(0);

    const progressEvents = events.filter(
      (e): e is Extract<RunnerEvent, { type: 'TestCaseProgress' }> => e.type === 'TestCaseProgress',
    );
    expect(progressEvents).toHaveLength(3);
    expect(progressEvents.every((e) => e.repetitionCount === 3)).toBe(true);
    expect(progressEvents.map((e) => e.repetitionIndex).sort()).toEqual([1, 2, 3]);
    const repIds = new Set(progressEvents.map((e) => e.repetitionId));
    expect(repIds.size).toBe(1);
  });

  test('runDatasetJobsWithSharedConcurrency attaches runConfig meta to evaluator args.meta', async () => {
    const { runner } = await withRunner();
    const [dataset] = await runner.collectDatasets();
    const [evaluator] = await runner.collectEvaluators();

    const progress = new Promise<RunnerEvent>((resolve) => {
      const unsubscribe = runner.subscribeRunEvents((event) => {
        if (event.type === 'TestCaseProgress') {
          unsubscribe();
          resolve(event);
        }
      });
    });

    await runner.runDatasetJobsWithSharedConcurrency({
      jobs: [
        {
          datasetId: dataset.id,
          evaluatorIds: [evaluator.id],
          runConfigName: 'fixture-rc',
          repetitions: 1,
        },
      ],
      globalConcurrency: 2,
    });

    const ev = await progress;
    expect(ev.type).toBe('TestCaseProgress');
    const meta = ev.evaluatorScores[0]?.scores[1]?.data as
      | {
          runConfigName?: string;
          datasetName?: string;
        }
      | undefined;
    expect(meta?.datasetName).toBe('Alpha Dataset');
    expect(meta?.runConfigName).toBe('fixture-rc');
  });

  test('prefers createRunner overrides over m4trix-eval.config.ts', async () => {
    const root = await createFixtureWorkspace('.ts', {
      dataset: '.custom-dataset.ts',
      evaluator: '.custom-evaluator.ts',
      testCase: '.custom-test-case.ts',
    });
    await writeFile(
      join(root, 'm4trix-eval.config.ts'),
      [
        'export default {',
        `  artifactDirectory: ${JSON.stringify(join(root, 'config-results'))},`,
        '  discovery: {',
        `    rootDir: ${JSON.stringify(root)},`,
        "    datasetFilePatterns: ['.wrong-dataset.ts'],",
        "    evaluatorFilePatterns: ['.wrong-evaluator.ts'],",
        "    testCaseFilePatterns: ['.wrong-test-case.ts'],",
        '    excludeDirectories: [],',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const runner = createRunner({
      discovery: {
        datasetSuffixes: ['.custom-dataset.ts'],
        evaluatorSuffixes: ['.custom-evaluator.ts'],
        testCaseSuffixes: ['.custom-test-case.ts'],
      },
    });
    runners.push(runner);
    workspaces.push(root);

    const datasets = await runner.collectDatasets();
    const evaluators = await runner.collectEvaluators();
    const testCases = await runner.searchTestCases();

    expect(datasets).toHaveLength(1);
    expect(evaluators).toHaveLength(1);
    expect(testCases).toHaveLength(2);
  });
});
