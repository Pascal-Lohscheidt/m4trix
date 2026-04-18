import type { Dataset } from '../evals/dataset.js';
import type { EvaluatorLogEntry } from '../evals/diff.js';
import type { Evaluator } from '../evals/evaluator.js';
import type { MetricItem } from '../evals/metric.js';
import type { RunConfig, RunConfigSampling } from '../evals/run-config.js';
import type { ScoreItem } from '../evals/score.js';
import type { TestCase } from '../evals/test-case.js';

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

export interface CollectedRunConfig {
  id: string;
  filePath: string;
  runConfig: RunConfig;
}

/** One dataset + evaluator set queued as part of a RunConfig or batch run. */
export interface RunDatasetJob {
  datasetId: string;
  evaluatorIds: ReadonlyArray<string>;
  /** RunConfig name (same as `RunConfig.getName()`). */
  runConfigName: string;
  /**
   * Human-facing RunConfig label (`displayName ?? name`) when the job was expanded from `RunConfig.define`.
   * Omitted for ad-hoc jobs; UI should fall back to {@link runConfigName}.
   */
  runConfigDisplayLabel?: string;
  /**
   * Tags from `RunConfig.define({ tags })` for this job; forwarded as `meta.runConfigTags` on evaluator callbacks.
   */
  runConfigTags?: ReadonlyArray<string>;
  /** Evaluates each matching test case this many times (default 1). */
  repetitions: number;
  /** When set, runner includes only a random subset of dataset test cases (see `RunConfigSampling`). */
  sampling?: RunConfigSampling;
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

/** Use with `RunDatasetRequest` for API / TUI runs that are not backed by a `RunConfig` file. */
export const PROGRAMMATIC_RUN_CONFIG = {
  runConfigName: 'programmatic',
} as const;

export interface RunDatasetRequest {
  /**
   * Identifier for what triggered the run request (for example, a CLI command).
   * When omitted, the runner generates one in the format `trg-[uuid]`.
   */
  triggerId?: string;
  /**
   * When the run was triggered (`Date.now()` ms); defaults to now. Forwarded as `meta.triggerTimestamp`.
   */
  triggerTimestamp?: number;
  datasetId: string;
  evaluatorIds: ReadonlyArray<string>;
  /** RunConfig name surfaced on evaluator `meta` (from the job or `PROGRAMMATIC_RUN_CONFIG`). */
  runConfigName: string;
  concurrency?: number;
  /**
   * How many times each test case is executed (default: 1). For RunConfig-backed runs, set per row on the config.
   */
  repetitions?: number;
  /**
   * Optional tags for this run; forwarded as `meta.runConfigTags` on evaluator callbacks (e.g. suite labels).
   */
  runConfigTags?: ReadonlyArray<string>;
  /**
   * Optional label for this run; forwarded as `experimentName` on evaluator `meta`.
   */
  experimentName?: string;
  /** Optional subsample of dataset test cases (same semantics as `RunConfig` row `sampling`). */
  sampling?: RunConfigSampling;
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
      repetitionId: string;
      repetitionIndex: number;
      repetitionCount: number;
    }
  | {
      type: 'TestCaseProgress';
      runId: string;
      testCaseId: string;
      testCaseName: string;
      completedTestCases: number;
      totalTestCases: number;
      repetitionId: string;
      repetitionIndex: number;
      repetitionCount: number;
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
