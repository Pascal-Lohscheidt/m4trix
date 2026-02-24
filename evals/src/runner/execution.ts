import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Effect, Queue, Ref } from 'effect';

import type {
  CreateDiffLogEntryOptions,
  EvaluatorLogEntry,
} from '../evals/diff';
import { createDiffLogEntry, createLogEntry } from '../evals/diff';
import type { Dataset } from '../evals/dataset';
import type { Evaluator } from '../evals/evaluator';
import type { MetricItem } from '../evals/metric';
import type { ScoreItem } from '../evals/score';
import type { CollectedTestCase, RunSnapshot, RunnerEvent } from './events';
import type { PersistenceMessage } from './persistence';
import { toNumericScoreFromScores } from './score-utils';

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

function normalizeResult(
  result: unknown,
): {
  scores: ReadonlyArray<ScoreItem>;
  metrics?: ReadonlyArray<MetricItem>;
} {
  if (typeof result !== 'object' || result === null) {
    return { scores: [] };
  }
  const obj = result as Record<string, unknown>;
  const scores = Array.isArray(obj.scores)
    ? (obj.scores as ReadonlyArray<ScoreItem>)
    : [];
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
}

function nowIsoForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function createArtifactPath(
  artifactDirectory: string,
  datasetId: string,
  runId: string,
): string {
  return join(
    artifactDirectory,
    `${datasetId}_${runId}_${nowIsoForFile()}.jsonl`,
  );
}

function processOneTestCase(
  task: RunTask,
  testCaseItem: CollectedTestCase,
  totalEvaluations: number,
  publishEvent: (event: RunnerEvent) => Effect.Effect<void, never, never>,
  persistenceQueue: Queue.Queue<PersistenceMessage>,
  updateSnapshot: (
    runId: string,
    updater: (snapshot: RunSnapshot) => RunSnapshot,
  ) => void,
  completedRef: Ref.Ref<number>,
  passedRef: Ref.Ref<number>,
  failedRef: Ref.Ref<number>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const reruns =
      typeof testCaseItem.testCase.getReruns === 'function'
        ? testCaseItem.testCase.getReruns()
        : 1;
    const rerunPassed: boolean[] = [];

    for (let r = 0; r < reruns; r++) {
      const evaluatorRunId = `run-${randomUUID()}`;
      const started = Date.now();
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

        try {
          const logs: EvaluatorLogEntry[] = [];
          const logDiff = (
            expected: unknown,
            actual: unknown,
            options?: CreateDiffLogEntryOptions,
          ) => {
            logs.push(createDiffLogEntry(expected, actual, options));
          };
          const log = (message: unknown, options?: { label?: string }) => {
            logs.push(createLogEntry(message, options));
          };

          const ctx = yield* Effect.promise(() =>
            Promise.resolve(evaluator.resolveContext()),
          );
          const result = yield* Effect.promise(() =>
              Promise.resolve(
              evaluateFn({
                input: testCaseItem.testCase.getInput(),
                ctx,
                output,
                meta: {
                  triggerId: task.triggerId,
                  runId: evaluatorRunId,
                  datasetId: task.datasetId,
                },
                logDiff,
                log,
              }),
            ),
          );
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
          testCaseError =
            error instanceof Error
              ? error.message
              : 'Evaluator execution failed';
          evaluatorScores.push({
            evaluatorId,
            scores: [],
            passed: false,
          });
        }
      }

      const rerunPassedThis = evaluatorScores.every((s) => s.passed);
      rerunPassed.push(rerunPassedThis);
      const completedEvaluations = yield* Ref.modify(completedRef, (n) => [
        n + 1,
        n + 1,
      ]);

      const progressEvent: RunnerEvent = {
        type: 'TestCaseProgress',
        runId: task.runId,
        testCaseId: testCaseItem.id,
        testCaseName: testCaseItem.testCase.getName(),
        completedTestCases: completedEvaluations,
        totalTestCases: totalEvaluations,
        rerunIndex: r + 1,
        rerunTotal: reruns,
        passed: rerunPassedThis,
        durationMs: Date.now() - started,
        evaluatorScores,
        output,
        errorMessage: testCaseError,
      };

      updateSnapshot(task.runId, (snapshot) => ({
        ...snapshot,
        completedTestCases: completedEvaluations,
      }));

      yield* publishEvent(progressEvent);
      yield* Queue.offer(persistenceQueue, {
        runId: task.runId,
        artifactPath: task.snapshot.artifactPath,
        payload: progressEvent,
      });
    }

    const testCasePassed = rerunPassed.every(Boolean);
    if (testCasePassed) {
      yield* Ref.update(passedRef, (n) => n + 1);
    } else {
      yield* Ref.update(failedRef, (n) => n + 1);
    }

    const [passed, failed] = yield* Effect.all([
      Ref.get(passedRef),
      Ref.get(failedRef),
    ]);
    updateSnapshot(task.runId, (snapshot) => ({
      ...snapshot,
      passedTestCases: passed,
      failedTestCases: failed,
    }));
  });
}

export const executeRunTask = (
  task: RunTask,
  publishEvent: (event: RunnerEvent) => Effect.Effect<void, never, never>,
  persistenceQueue: Queue.Queue<PersistenceMessage>,
  updateSnapshot: (
    runId: string,
    updater: (snapshot: RunSnapshot) => RunSnapshot,
  ) => void,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    updateSnapshot(task.runId, (snapshot) => ({
      ...snapshot,
      status: 'running',
      startedAt,
    }));
    yield* publishEvent({
      type: 'RunStarted',
      runId: task.runId,
      startedAt,
    });

    const totalEvaluations = task.testCases.reduce(
      (sum, tc) =>
        sum +
        (typeof tc.testCase.getReruns === 'function'
          ? tc.testCase.getReruns()
          : 1),
      0,
    );
    const maxConcurrency = Math.max(1, task.maxConcurrency ?? 1);

    const completedRef = yield* Ref.make(0);
    const passedRef = yield* Ref.make(0);
    const failedRef = yield* Ref.make(0);

    const processTestCase = (testCaseItem: CollectedTestCase) =>
      processOneTestCase(
        task,
        testCaseItem,
        totalEvaluations,
        publishEvent,
        persistenceQueue,
        updateSnapshot,
        completedRef,
        passedRef,
        failedRef,
      );

    yield* Effect.forEach(
      task.testCases,
      processTestCase,
      maxConcurrency > 1 ? { concurrency: maxConcurrency } : undefined,
    );

    const [completedEvaluations, passedUniqueTestCases, failedUniqueTestCases] =
      yield* Effect.all([
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

    updateSnapshot(task.runId, (snapshot) => ({
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
