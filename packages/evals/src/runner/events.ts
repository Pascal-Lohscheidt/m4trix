import type { Dataset } from '../evals/dataset';
import type { EvaluatorLogEntry } from '../evals/diff';
import type { Evaluator } from '../evals/evaluator';
import type { MetricItem } from '../evals/metric';
import type { ScoreItem } from '../evals/score';
import type { TestCase } from '../evals/test-case';

export interface CollectedDataset {
  id: string;
  filePath: string;
  dataset: Dataset;
}

export interface CollectedEvaluator {
  id: string;
  filePath: string;
  evaluator: Evaluator<unknown, unknown, unknown, unknown>;
}

export interface CollectedTestCase {
  id: string;
  filePath: string;
  testCase: TestCase<unknown, unknown>;
}

export interface SearchTestCasesQuery {
  includedTags?: ReadonlyArray<string | RegExp>;
  excludedTags?: ReadonlyArray<string | RegExp>;
  includedPaths?: ReadonlyArray<string | RegExp>;
  excludedPaths?: ReadonlyArray<string | RegExp>;
}

export interface RunDatasetRequest {
  /**
   * Identifier for what triggered the run request (for example, a CLI command).
   * When omitted, the runner generates one in the format `trg-[uuid]`.
   */
  triggerId?: string;
  datasetId: string;
  evaluatorIds: ReadonlyArray<string>;
  concurrency?: number;
}

export interface RunSnapshot {
  runId: string;
  datasetId: string;
  datasetName: string;
  evaluatorIds: ReadonlyArray<string>;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  totalTestCases: number;
  completedTestCases: number;
  passedTestCases: number;
  failedTestCases: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  artifactPath: string;
  errorMessage?: string;
}

export type RunnerEvent =
  | {
      type: 'RunQueued';
      runId: string;
      datasetId: string;
      datasetName: string;
      evaluatorIds: ReadonlyArray<string>;
      totalTestCases: number;
      artifactPath: string;
    }
  | {
      type: 'RunStarted';
      runId: string;
      startedAt: number;
    }
  | {
      type: 'TestCaseStarted';
      runId: string;
      testCaseId: string;
      testCaseName: string;
      startedTestCases: number;
      totalTestCases: number;
      rerunIndex: number;
      rerunTotal: number;
    }
  | {
      type: 'TestCaseProgress';
      runId: string;
      testCaseId: string;
      testCaseName: string;
      completedTestCases: number;
      totalTestCases: number;
      rerunIndex: number;
      rerunTotal: number;
      passed: boolean;
      durationMs: number;
      evaluatorScores: ReadonlyArray<{
        evaluatorId: string;
        scores: ReadonlyArray<ScoreItem>;
        passed: boolean;
        metrics?: ReadonlyArray<MetricItem>;
        logs?: ReadonlyArray<EvaluatorLogEntry>;
      }>;
      output?: unknown;
      errorMessage?: string;
    }
  | {
      type: 'RunCompleted';
      runId: string;
      finishedAt: number;
      passedTestCases: number;
      failedTestCases: number;
      totalTestCases: number;
      artifactPath: string;
    }
  | {
      type: 'RunFailed';
      runId: string;
      finishedAt: number;
      errorMessage: string;
      artifactPath: string;
    }
  | {
      type: 'ArtifactFlushed';
      runId: string;
      artifactPath: string;
    };
