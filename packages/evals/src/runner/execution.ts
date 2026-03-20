import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Effect, Queue, Ref } from 'effect';
import type { Dataset } from '../evals/dataset';
import type { CreateDiffLogEntryOptions, EvaluatorLogEntry } from '../evals/diff';
import { createDiffLogEntry, createLogEntry } from '../evals/diff';
import type { Evaluator } from '../evals/evaluator';
import { getEvaluatorTagList } from '../evals/evaluator';
import type { MetricItem } from '../evals/metric';
import type { ScoreItem } from '../evals/score';
import { getTestCaseDisplayLabel, getTestCaseTagList } from '../evals/test-case';
import type { CollectedTestCase, RunnerEvent, RunSnapshot } from './events';
import type { PersistenceMessage } from './persistence';
import { toNumericScoreFromScores } from './score-utils';

const evaluatorErrorLogEntryKey = '__m4trixEvaluatorLogEntry';

type EvaluatorCreatedError = Error & {
  [evaluatorErrorLogEntryKey]?: EvaluatorLogEntry;
};

function computeEvaluatorPassed(
  evaluator: Evaluator<unknown, unknown, unknown, unknown>,
  result: unknown,
  scores: ReadonlyArray<ScoreItem>,
): boolean {
  const scoresWithPassed = scores.filter((s) => 'passed' in s && s.passed !== undefined);
  if (scoresWithPassed.length > 0) {
    return scoresWithPassed.every((s) => s.passed === true);
  }
  const passCriterion = evaluator.getPassCriterion();
  if (passCriterion) {
    return passCriterion(result);
  }
  const passThreshold = evaluator.getPassThreshold();
  if (passThreshold !== undefined) {
    const numeric = toNumericScoreFromScores(scores);
    return numeric !== undefined && numeric >= passThreshold;
  }
  return true;
}

function normalizeResult(result: unknown): {
  scores: ReadonlyArray<ScoreItem>;
  metrics?: ReadonlyArray<MetricItem>;
} {
  if (typeof result !== 'object' || result === null) {
    return { scores: [] };
  }
  const obj = result as Record<string, unknown>;
  const scores = Array.isArray(obj.scores) ? (obj.scores as ReadonlyArray<ScoreItem>) : [];
  const metrics = Array.isArray(obj.metrics)
    ? (obj.metrics as ReadonlyArray<MetricItem>)
    : undefined;
  return { scores, metrics };
}

function readOutput(testCase: CollectedTestCase['testCase']): unknown {
  const candidate = testCase as unknown as { getOutput?: () => unknown };
  if (typeof candidate.getOutput !== 'function') {
    return undefined;
  }
  return candidate.getOutput();
}

export interface RunTask {
  runId: string;
  triggerId: string;
  datasetId: string;
  dataset: Dataset;
  evaluators: ReadonlyArray<{
    id: string;
    evaluator: Evaluator<unknown, unknown, unknown, unknown>;
  }>;
  testCases: ReadonlyArray<CollectedTestCase>;
  snapshot: RunSnapshot;
  maxConcurrency: number;
  /** When set, limits concurrent evaluation units across all runs sharing this semaphore. */
  globalEvaluationSemaphore?: ReturnType<typeof Effect.unsafeMakeSemaphore>;
  runConfigName: string;
  /** When set, forwarded as `experimentName` on evaluator `meta`. */
  experimentName?: string;
  /** Per job: tags from the run config or programmatic request; forwarded to evaluator callbacks. */
  runConfigTags: string[];
  /** Per scheduled job: how many times each dataset test case is executed. */
  repetitions: number;
}

interface EvaluationUnit {
  testCaseItem: CollectedTestCase;
  repetitionId: string;
  repetitionIndex: number;
  repetitionCount: number;
}

function buildEvaluationUnits(
  testCases: ReadonlyArray<CollectedTestCase>,
  repetitionCount: number,
): EvaluationUnit[] {
  const count = Math.max(1, repetitionCount);
  const units: EvaluationUnit[] = [];
  for (const testCaseItem of testCases) {
    const repetitionId = `rep-${randomUUID()}`;
    for (let r = 0; r < count; r++) {
      units.push({
        testCaseItem,
        repetitionId,
        repetitionIndex: r + 1,
        repetitionCount: count,
      });
    }
  }
  return units;
}

function nowIsoForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function createArtifactPath(
  artifactDirectory: string,
  datasetId: string,
  runId: string,
): string {
  return join(artifactDirectory, `${datasetId}_${runId}_${nowIsoForFile()}.jsonl`);
}

function processOneEvaluation(
  task: RunTask,
  unit: EvaluationUnit,
  totalEvaluations: number,
  publishEvent: (event: RunnerEvent) => Effect.Effect<void, never, never>,
  persistenceQueue: Queue.Queue<PersistenceMessage>,
  updateSnapshot: (
    runId: string,
    updater: (snapshot: RunSnapshot) => RunSnapshot,
  ) => Effect.Effect<void, never, never>,
  startedRef: Ref.Ref<number>,
  completedRef: Ref.Ref<number>,
  passedRef: Ref.Ref<number>,
  failedRef: Ref.Ref<number>,
  testCaseResultsRef: Ref.Ref<Map<string, { completedCount: number; results: boolean[] }>>,
): Effect.Effect<void, never, never> {
  const { testCaseItem, repetitionId, repetitionIndex, repetitionCount } = unit;
  return Effect.gen(function* () {
    const evaluatorRunId = `run-${randomUUID()}`;
    const started = Date.now();
    const startedEvaluations = yield* Ref.modify(startedRef, (n) => [n + 1, n + 1]);
    yield* publishEvent({
      type: 'TestCaseStarted',
      runId: task.runId,
      testCaseId: testCaseItem.id,
      testCaseName: getTestCaseDisplayLabel(testCaseItem.testCase),
      startedTestCases: startedEvaluations,
      totalTestCases: totalEvaluations,
      repetitionId,
      repetitionIndex,
      repetitionCount,
    });
    const evaluatorScores: Array<{
      evaluatorId: string;
      scores: ReadonlyArray<ScoreItem>;
      passed: boolean;
      metrics?: ReadonlyArray<MetricItem>;
      logs?: ReadonlyArray<EvaluatorLogEntry>;
    }> = [];
    let testCaseError: string | undefined;
    const output = readOutput(testCaseItem.testCase);

    for (const { id: evaluatorId, evaluator } of task.evaluators) {
      const evaluateFn = evaluator.getEvaluateFn();
      if (!evaluateFn) {
        continue;
      }

      const logs: EvaluatorLogEntry[] = [];
      const logDiff = (expected: unknown, actual: unknown, options?: CreateDiffLogEntryOptions) => {
        logs.push(createDiffLogEntry(expected, actual, options));
      };
      const log = (message: unknown, options?: { label?: string }) => {
        logs.push(createLogEntry(message, options));
      };
      const createError = (message: unknown, options?: { label?: string }): Error => {
        const entry = createLogEntry(message, options);
        const error = message instanceof Error ? message : new Error(entry.message);
        (error as EvaluatorCreatedError)[evaluatorErrorLogEntryKey] = entry;
        return error;
      };

      try {
        const ctx = yield* Effect.promise(() => Promise.resolve(evaluator.resolveContext()));
        const result = yield* Effect.promise(() =>
          Promise.resolve().then(() =>
            evaluateFn({
              input: testCaseItem.testCase.getInput(),
              ctx,
              output,
              meta: {
                triggerId: task.triggerId,
                runId: evaluatorRunId,
                datasetName: task.dataset.getDisplayLabel(),
                testCaseId: testCaseItem.id,
                testCaseName: getTestCaseDisplayLabel(testCaseItem.testCase),
                repetitionId,
                repetitionIndex,
                repetitionCount,
                runConfigName: task.runConfigName,
                ...(task.experimentName !== undefined && task.experimentName !== ''
                  ? { experimentName: task.experimentName }
                  : {}),
                testCaseTags: getTestCaseTagList(testCaseItem.testCase),
                runConfigTags: task.runConfigTags,
                evaluatorTags: getEvaluatorTagList(evaluator),
              },
              logDiff,
              log,
              createError,
            }),
          ),
        );
        if (result instanceof Error) {
          const evaluatorError = result as EvaluatorCreatedError;
          const taggedEntry = evaluatorError[evaluatorErrorLogEntryKey];
          logs.push(taggedEntry ?? createLogEntry(result));
          testCaseError = result.message;
          evaluatorScores.push({
            evaluatorId,
            scores: [],
            passed: false,
            logs: logs.length > 0 ? logs : undefined,
          });
          continue;
        }
        const { scores, metrics } = normalizeResult(result);
        const passed = computeEvaluatorPassed(evaluator, result, scores);
        evaluatorScores.push({
          evaluatorId,
          scores,
          passed,
          metrics,
          logs: logs.length > 0 ? logs : undefined,
        });
      } catch (error) {
        if (error instanceof Error) {
          const taggedEntry = (error as EvaluatorCreatedError)[evaluatorErrorLogEntryKey];
          logs.push(taggedEntry ?? createLogEntry(error));
        }
        testCaseError = error instanceof Error ? error.message : 'Evaluator execution failed';
        evaluatorScores.push({
          evaluatorId,
          scores: [],
          passed: false,
          logs: logs.length > 0 ? logs : undefined,
        });
      }
    }

    const repetitionPassedThis = evaluatorScores.every((s) => s.passed);
    const completedEvaluations = yield* Ref.modify(completedRef, (n) => [n + 1, n + 1]);

    const progressEvent: RunnerEvent = {
      type: 'TestCaseProgress',
      runId: task.runId,
      testCaseId: testCaseItem.id,
      testCaseName: getTestCaseDisplayLabel(testCaseItem.testCase),
      completedTestCases: completedEvaluations,
      totalTestCases: totalEvaluations,
      repetitionId,
      repetitionIndex,
      repetitionCount,
      passed: repetitionPassedThis,
      durationMs: Date.now() - started,
      evaluatorScores,
      output,
      errorMessage: testCaseError,
    };

    yield* updateSnapshot(task.runId, (snapshot) => ({
      ...snapshot,
      completedTestCases: completedEvaluations,
    }));

    yield* publishEvent(progressEvent);
    yield* Queue.offer(persistenceQueue, {
      runId: task.runId,
      artifactPath: task.snapshot.artifactPath,
      payload: progressEvent,
    });

    const testCaseCompleted = yield* Ref.modify(
      testCaseResultsRef,
      (map): [boolean | null, Map<string, { completedCount: number; results: boolean[] }>] => {
        const key = testCaseItem.id;
        const existing = map.get(key) ?? { completedCount: 0, results: [] };
        const newResults = [...existing.results, repetitionPassedThis];
        const newCompletedCount = existing.completedCount + 1;
        const isLast = newCompletedCount === repetitionCount;
        const newMap = new Map(map);
        newMap.set(key, {
          completedCount: newCompletedCount,
          results: newResults,
        });
        const outcome: boolean | null = isLast ? newResults.every(Boolean) : null;
        return [outcome, newMap];
      },
    );

    if (testCaseCompleted !== null) {
      if (testCaseCompleted) {
        yield* Ref.update(passedRef, (n) => n + 1);
      } else {
        yield* Ref.update(failedRef, (n) => n + 1);
      }
      const [passed, failed] = yield* Effect.all([Ref.get(passedRef), Ref.get(failedRef)]);
      yield* updateSnapshot(task.runId, (snapshot) => ({
        ...snapshot,
        passedTestCases: passed,
        failedTestCases: failed,
      }));
    }
  });
}

export const executeRunTask = (
  task: RunTask,
  publishEvent: (event: RunnerEvent) => Effect.Effect<void, never, never>,
  persistenceQueue: Queue.Queue<PersistenceMessage>,
  updateSnapshot: (
    runId: string,
    updater: (snapshot: RunSnapshot) => RunSnapshot,
  ) => Effect.Effect<void, never, never>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    yield* updateSnapshot(task.runId, (snapshot) => ({
      ...snapshot,
      status: 'running',
      startedAt,
    }));
    yield* publishEvent({
      type: 'RunStarted',
      runId: task.runId,
      startedAt,
    });

    const totalEvaluations = task.testCases.length * Math.max(1, task.repetitions);
    const maxConcurrency = Math.max(1, task.maxConcurrency ?? 1);

    const completedRef = yield* Ref.make(0);
    const startedRef = yield* Ref.make(0);
    const passedRef = yield* Ref.make(0);
    const failedRef = yield* Ref.make(0);
    const testCaseResultsRef = yield* Ref.make(
      new Map<string, { completedCount: number; results: boolean[] }>(),
    );

    const evaluationUnits = buildEvaluationUnits(task.testCases, task.repetitions);

    const processEvaluation = (unit: EvaluationUnit) =>
      processOneEvaluation(
        task,
        unit,
        totalEvaluations,
        publishEvent,
        persistenceQueue,
        updateSnapshot,
        startedRef,
        completedRef,
        passedRef,
        failedRef,
        testCaseResultsRef,
      );

    const globalSem = task.globalEvaluationSemaphore;
    if (globalSem !== undefined) {
      yield* Effect.forEach(
        evaluationUnits,
        (unit) => globalSem.withPermits(1)(processEvaluation(unit)),
        { concurrency: 'unbounded', discard: true },
      );
    } else {
      yield* Effect.forEach(
        evaluationUnits,
        processEvaluation,
        maxConcurrency > 1 ? { concurrency: maxConcurrency } : undefined,
      );
    }

    const [completedEvaluations, passedUniqueTestCases, failedUniqueTestCases] = yield* Effect.all([
      Ref.get(completedRef),
      Ref.get(passedRef),
      Ref.get(failedRef),
    ]);

    const finishedAt = Date.now();
    const completedEvent: RunnerEvent = {
      type: 'RunCompleted',
      runId: task.runId,
      finishedAt,
      passedTestCases: passedUniqueTestCases,
      failedTestCases: failedUniqueTestCases,
      totalTestCases: task.testCases.length,
      artifactPath: task.snapshot.artifactPath,
    };

    yield* updateSnapshot(task.runId, (snapshot) => ({
      ...snapshot,
      status: 'completed',
      completedTestCases: completedEvaluations,
      passedTestCases: passedUniqueTestCases,
      failedTestCases: failedUniqueTestCases,
      finishedAt,
    }));

    yield* publishEvent(completedEvent);
    yield* Queue.offer(persistenceQueue, {
      runId: task.runId,
      artifactPath: task.snapshot.artifactPath,
      payload: completedEvent,
    });
    yield* publishEvent({
      type: 'ArtifactFlushed',
      runId: task.runId,
      artifactPath: task.snapshot.artifactPath,
    });
  });
