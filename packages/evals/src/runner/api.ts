import { randomUUID } from 'node:crypto';

import { Effect, Fiber, PubSub, Queue, Ref } from 'effect';
import { validateRunConfigName } from '../evals/run-config';
import { loadRunSnapshotsFromArtifacts as loadSnapshotsFromArtifacts } from './artifact-loader';
import type { RunnerConfig, RunnerConfigOverrides } from './config';
import { withRunnerConfig } from './config';
import { loadRunnerConfigFile } from './config-loader';
import {
  collectDatasetsFromFiles,
  collectEvaluatorsFromFiles,
  collectRunConfigsFromFiles,
  collectTestCasesFromFiles,
} from './discovery';
import type {
  CollectedDataset,
  CollectedEvaluator,
  CollectedRunConfig,
  CollectedTestCase,
  RunDatasetJob,
  RunDatasetRequest,
  RunnerEvent,
  RunSnapshot,
  SearchTestCasesQuery,
} from './events';
import { createArtifactPath, executeRunTask, type RunTask } from './execution';
import { createNameMatcher } from './name-pattern';
import { createPersistenceWorker } from './persistence';
import { searchCollectedTestCases } from './search';

interface SubscribeOptions {
  runId?: string;
}

function normalizeRunRepetitions(value: number | undefined): number {
  const n = value ?? 1;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`repetitions must be a positive integer, got ${String(value)}`);
  }
  return n;
}

export interface RunDatasetJobsWithSharedConcurrencyRequest {
  jobs: ReadonlyArray<RunDatasetJob>;
  globalConcurrency: number;
  triggerId?: string;
}

export interface RunnerApi {
  collectDatasets(): Promise<ReadonlyArray<CollectedDataset>>;
  collectEvaluators(): Promise<ReadonlyArray<CollectedEvaluator>>;
  collectRunConfigs(): Promise<ReadonlyArray<CollectedRunConfig>>;
  resolveDatasetByName(name: string): Promise<CollectedDataset | undefined>;
  resolveEvaluatorsByNamePattern(pattern: string): Promise<ReadonlyArray<CollectedEvaluator>>;
  /**
   * Resolves a RunConfig by display name (case-insensitive).
   * @throws If more than one discovered RunConfig uses the same name (list file paths in the error).
   */
  resolveRunConfigByName(name: string): Promise<CollectedRunConfig | undefined>;
  expandRunConfigToJobs(collected: CollectedRunConfig): Promise<ReadonlyArray<RunDatasetJob>>;
  /** Resolves each name in order and concatenates expanded jobs (the same name may appear more than once). */
  expandRunConfigNamesToJobs(names: ReadonlyArray<string>): Promise<ReadonlyArray<RunDatasetJob>>;
  runDatasetJobsWithSharedConcurrency(
    request: RunDatasetJobsWithSharedConcurrencyRequest,
  ): Promise<ReadonlyArray<RunSnapshot>>;
  searchTestCases(query?: SearchTestCasesQuery): Promise<ReadonlyArray<CollectedTestCase>>;
  collectDatasetTestCases(datasetId: string): Promise<ReadonlyArray<CollectedTestCase>>;
  runDatasetWith(request: RunDatasetRequest): Promise<RunSnapshot>;
  subscribeRunEvents(
    listener: (event: RunnerEvent) => void,
    options?: SubscribeOptions,
  ): () => void;
  getRunSnapshot(runId: string): RunSnapshot | undefined;
  getAllRunSnapshots(): ReadonlyArray<RunSnapshot>;
  loadRunSnapshotsFromArtifacts(): Promise<ReadonlyArray<RunSnapshot>>;
  shutdown(): Promise<void>;
}

function mergeRunnerOverrides(
  base?: RunnerConfigOverrides,
  next?: RunnerConfigOverrides,
): RunnerConfigOverrides | undefined {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }
  const discovery =
    base.discovery || next.discovery
      ? {
          ...(base.discovery ?? {}),
          ...(next.discovery ?? {}),
        }
      : undefined;
  return {
    ...base,
    ...next,
    discovery,
  };
}

export function createRunner(overrides?: RunnerConfigOverrides): RunnerApi {
  const fileOverrides = loadRunnerConfigFile();
  const merged = mergeRunnerOverrides(fileOverrides, overrides);
  return new EffectRunner(withRunnerConfig(merged));
}

class EffectRunner implements RunnerApi {
  private readonly config: RunnerConfig;

  private readonly eventBus = Effect.runSync(PubSub.unbounded<RunnerEvent>());

  private readonly runQueue = Effect.runSync(Queue.unbounded<RunTask>());

  private readonly persistenceQueue = Effect.runSync(
    Queue.unbounded<{
      runId: string;
      artifactPath: string;
      payload: unknown;
    }>(),
  );

  private readonly snapshotsRef = Effect.runSync(Ref.make(new Map<string, RunSnapshot>()));
  private readonly listeners = new Set<{
    runId?: string;
    listener: (event: RunnerEvent) => void;
  }>();

  private readonly datasetsById = new Map<string, CollectedDataset>();

  private readonly evaluatorsById = new Map<string, CollectedEvaluator>();

  private readonly runConfigsById = new Map<string, CollectedRunConfig>();

  private readonly schedulerFiber = Effect.runFork(this.createSchedulerEffect());

  private readonly persistenceFiber = Effect.runFork(
    createPersistenceWorker(this.persistenceQueue),
  );

  constructor(config: RunnerConfig) {
    this.config = config;
  }

  async collectDatasets(): Promise<ReadonlyArray<CollectedDataset>> {
    const datasets = await collectDatasetsFromFiles(this.config.discovery);
    this.datasetsById.clear();
    for (const dataset of datasets) {
      this.datasetsById.set(dataset.id, dataset);
    }
    return datasets;
  }

  async collectEvaluators(): Promise<ReadonlyArray<CollectedEvaluator>> {
    const evaluators = await collectEvaluatorsFromFiles(this.config.discovery);
    this.evaluatorsById.clear();
    for (const evaluator of evaluators) {
      this.evaluatorsById.set(evaluator.id, evaluator);
    }
    return evaluators;
  }

  async resolveDatasetByName(name: string): Promise<CollectedDataset | undefined> {
    if (this.datasetsById.size === 0) {
      await this.collectDatasets();
    }
    const normalized = name.trim().toLowerCase();
    return Array.from(this.datasetsById.values()).find(
      (item) => item.dataset.getName().toLowerCase() === normalized,
    );
  }

  async resolveEvaluatorsByNamePattern(
    pattern: string,
  ): Promise<ReadonlyArray<CollectedEvaluator>> {
    if (this.evaluatorsById.size === 0) {
      await this.collectEvaluators();
    }
    const matcher = createNameMatcher(pattern);
    return Array.from(this.evaluatorsById.values()).filter((item) =>
      matcher(item.evaluator.getName() ?? ''),
    );
  }

  async collectRunConfigs(): Promise<ReadonlyArray<CollectedRunConfig>> {
    const runConfigs = await collectRunConfigsFromFiles(this.config.discovery);
    this.runConfigsById.clear();
    const byNameLower = new Map<string, CollectedRunConfig>();
    for (const item of runConfigs) {
      const id = item.runConfig.getName();
      const lower = id.toLowerCase();
      const prev = byNameLower.get(lower);
      if (prev !== undefined && prev.filePath !== item.filePath) {
        throw new Error(
          `Duplicate RunConfig name "${id}" (matches "${prev.runConfig.getName()}" case-insensitively): ${prev.filePath} and ${item.filePath}`,
        );
      }
      byNameLower.set(lower, item);
      this.runConfigsById.set(id, item);
    }
    return runConfigs;
  }

  async resolveRunConfigByName(name: string): Promise<CollectedRunConfig | undefined> {
    if (this.runConfigsById.size === 0) {
      await this.collectRunConfigs();
    }
    const key = validateRunConfigName(name, `RunConfig "${name.trim()}"`);
    const keyLower = key.toLowerCase();
    const matches = Array.from(this.runConfigsById.values()).filter(
      (item) => item.runConfig.getName().toLowerCase() === keyLower,
    );
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple RunConfigs named "${name}": ${matches.map((m) => m.filePath).join(', ')}`,
      );
    }
    return matches[0];
  }

  async expandRunConfigToJobs(
    collected: CollectedRunConfig,
  ): Promise<ReadonlyArray<RunDatasetJob>> {
    if (this.datasetsById.size === 0) {
      await this.collectDatasets();
    }
    if (this.evaluatorsById.size === 0) {
      await this.collectEvaluators();
    }

    const rcName = collected.runConfig.getName();
    const jobs: RunDatasetJob[] = [];
    const runs = collected.runConfig.getRuns();

    for (const [i, row] of runs.entries()) {
      const dsCollected = Array.from(this.datasetsById.values()).find(
        (d) => d.dataset === row.dataset,
      );
      if (!dsCollected) {
        throw new Error(
          `RunConfig "${rcName}" run[${i}]: dataset "${row.dataset.getName()}" was not found among discovered dataset exports (import the same module instances the scanner loads).`,
        );
      }

      let evaluatorIds: string[];
      if ('evaluatorPattern' in row && typeof row.evaluatorPattern === 'string') {
        const matcher = createNameMatcher(row.evaluatorPattern);
        const matched = Array.from(this.evaluatorsById.values()).filter((item) =>
          matcher(item.evaluator.getName() ?? ''),
        );
        if (matched.length === 0) {
          throw new Error(
            `RunConfig "${rcName}" run[${i}]: no evaluator matched pattern "${row.evaluatorPattern}"`,
          );
        }
        evaluatorIds = matched.map((item) => item.id);
      } else {
        const evaluators = row.evaluators;
        evaluatorIds = [];
        for (const ev of evaluators) {
          const found = Array.from(this.evaluatorsById.values()).find(
            (item) => item.evaluator === ev,
          );
          if (!found) {
            throw new Error(
              `RunConfig "${rcName}" run[${i}]: evaluator "${ev.getName() ?? 'unknown'}" was not found among discovered evaluator exports`,
            );
          }
          evaluatorIds.push(found.id);
        }
      }

      const repetitions =
        'repetitions' in row && row.repetitions !== undefined ? row.repetitions : 1;

      jobs.push({
        datasetId: dsCollected.id,
        evaluatorIds,
        runConfigName: rcName,
        repetitions,
      });
    }

    return jobs;
  }

  async expandRunConfigNamesToJobs(
    names: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<RunDatasetJob>> {
    const jobs: RunDatasetJob[] = [];
    for (const name of names) {
      const collected = await this.resolveRunConfigByName(name);
      if (!collected) {
        const known = await this.collectRunConfigs();
        const available = known.map((r) => r.runConfig.getName()).sort();
        throw new Error(
          available.length > 0
            ? `RunConfig "${name}" not found. Available RunConfigs: ${available.join(', ')}`
            : `RunConfig "${name}" not found and no RunConfigs were discovered.`,
        );
      }
      jobs.push(...(await this.expandRunConfigToJobs(collected)));
    }
    return jobs;
  }

  async runDatasetJobsWithSharedConcurrency(
    request: RunDatasetJobsWithSharedConcurrencyRequest,
  ): Promise<ReadonlyArray<RunSnapshot>> {
    const globalConcurrency = Math.max(1, request.globalConcurrency);
    const sem = Effect.unsafeMakeSemaphore(globalConcurrency);
    const triggerId = request.triggerId ?? `trg-${randomUUID()}`;
    const snapshots: RunSnapshot[] = [];
    for (const job of request.jobs) {
      snapshots.push(
        await this.startDatasetRun({
          datasetId: job.datasetId,
          evaluatorIds: job.evaluatorIds,
          triggerId,
          maxConcurrency: this.config.maxConcurrency ?? 1,
          globalEvaluationSemaphore: sem,
          runConfigName: job.runConfigName,
          repetitions: job.repetitions,
        }),
      );
    }
    return snapshots;
  }

  async searchTestCases(query?: SearchTestCasesQuery): Promise<ReadonlyArray<CollectedTestCase>> {
    const testCases = await collectTestCasesFromFiles(this.config.discovery);
    return searchCollectedTestCases(testCases, query);
  }

  async collectDatasetTestCases(datasetId: string): Promise<ReadonlyArray<CollectedTestCase>> {
    if (this.datasetsById.size === 0) {
      await this.collectDatasets();
    }
    const dataset = this.datasetsById.get(datasetId);
    if (!dataset) {
      throw new Error(`Unknown dataset: ${datasetId}`);
    }
    const allTestCases = await collectTestCasesFromFiles(this.config.discovery);
    return allTestCases.filter((testCase) =>
      dataset.dataset.matchesTestCase(testCase.testCase, testCase.filePath),
    );
  }

  async runDatasetWith(request: RunDatasetRequest): Promise<RunSnapshot> {
    const runConfigName = validateRunConfigName(
      request.runConfigName,
      'runDatasetWith.runConfigName',
    );
    return this.startDatasetRun({
      datasetId: request.datasetId,
      evaluatorIds: request.evaluatorIds,
      triggerId: request.triggerId,
      maxConcurrency: request.concurrency ?? this.config.maxConcurrency ?? 1,
      repetitions: request.repetitions,
      runConfigName,
    });
  }

  private async startDatasetRun(params: {
    datasetId: string;
    evaluatorIds: ReadonlyArray<string>;
    triggerId?: string;
    maxConcurrency: number;
    globalEvaluationSemaphore?: ReturnType<typeof Effect.unsafeMakeSemaphore>;
    runConfigName: string;
    repetitions?: number;
  }): Promise<RunSnapshot> {
    if (this.datasetsById.size === 0) {
      await this.collectDatasets();
    }
    if (this.evaluatorsById.size === 0) {
      await this.collectEvaluators();
    }

    const dataset = this.datasetsById.get(params.datasetId);
    if (!dataset) {
      throw new Error(`Unknown dataset: ${params.datasetId}`);
    }

    const selectedEvaluators = params.evaluatorIds
      .map((id) => this.evaluatorsById.get(id))
      .filter((value): value is CollectedEvaluator => Boolean(value))
      .map((value) => ({ id: value.id, evaluator: value.evaluator }));

    if (selectedEvaluators.length === 0) {
      throw new Error('No evaluators selected for run');
    }

    const selectedTestCases = await this.collectDatasetTestCases(params.datasetId);

    const repetitions = normalizeRunRepetitions(params.repetitions);
    const totalEvaluations = selectedTestCases.length * repetitions;

    const triggerId = params.triggerId ?? `trg-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const artifactPath = createArtifactPath(this.config.artifactDirectory, params.datasetId, runId);
    const snapshot: RunSnapshot = {
      runId,
      datasetId: params.datasetId,
      datasetName: dataset.dataset.getName(),
      evaluatorIds: selectedEvaluators.map((item) => item.id),
      queuedAt: Date.now(),
      totalTestCases: totalEvaluations,
      completedTestCases: 0,
      passedTestCases: 0,
      failedTestCases: 0,
      status: 'queued',
      artifactPath,
    };

    await Effect.runPromise(
      Ref.update(this.snapshotsRef, (map) => {
        const next = new Map(map);
        next.set(runId, snapshot);
        return next;
      }),
    );
    const queuedEvent: RunnerEvent = {
      type: 'RunQueued',
      runId,
      datasetId: params.datasetId,
      datasetName: dataset.dataset.getName(),
      evaluatorIds: selectedEvaluators.map((item) => item.id),
      totalTestCases: totalEvaluations,
      artifactPath,
    };
    await Effect.runPromise(this.publishEvent(queuedEvent));
    await Effect.runPromise(
      Queue.offer(this.persistenceQueue, {
        runId,
        artifactPath,
        payload: queuedEvent,
      }),
    );

    await Effect.runPromise(
      Queue.offer(this.runQueue, {
        runId,
        triggerId,
        datasetId: params.datasetId,
        dataset: dataset.dataset,
        evaluators: selectedEvaluators,
        testCases: selectedTestCases,
        snapshot,
        maxConcurrency: params.maxConcurrency,
        globalEvaluationSemaphore: params.globalEvaluationSemaphore,
        runConfigName: params.runConfigName,
        repetitions,
      }),
    );

    return snapshot;
  }

  subscribeRunEvents(
    listener: (event: RunnerEvent) => void,
    options?: SubscribeOptions,
  ): () => void {
    const entry = { runId: options?.runId, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  getRunSnapshot(runId: string): RunSnapshot | undefined {
    return Effect.runSync(Ref.get(this.snapshotsRef)).get(runId);
  }

  getAllRunSnapshots(): ReadonlyArray<RunSnapshot> {
    return Array.from(Effect.runSync(Ref.get(this.snapshotsRef)).values()).sort(
      (a, b) => b.queuedAt - a.queuedAt,
    );
  }

  async loadRunSnapshotsFromArtifacts(): Promise<ReadonlyArray<RunSnapshot>> {
    return loadSnapshotsFromArtifacts(this.config);
  }

  async shutdown(): Promise<void> {
    await Effect.runPromise(Fiber.interrupt(this.schedulerFiber));
    await Effect.runPromise(Fiber.interrupt(this.persistenceFiber));
    await Effect.runPromise(Queue.shutdown(this.runQueue));
    await Effect.runPromise(Queue.shutdown(this.persistenceQueue));
    await Effect.runPromise(PubSub.shutdown(this.eventBus));
  }

  private createSchedulerEffect() {
    const self = this;
    return Effect.forever(
      Effect.gen(function* () {
        const task = yield* Queue.take(self.runQueue);
        yield* Effect.fork(
          executeRunTask(
            task,
            self.publishEvent.bind(self),
            self.persistenceQueue,
            self.updateSnapshot.bind(self),
          ),
        );
      }),
    );
  }

  private updateSnapshot(
    runId: string,
    updater: (snapshot: RunSnapshot) => RunSnapshot,
  ): Effect.Effect<void, never, never> {
    return Ref.modify(this.snapshotsRef, (map) => {
      const existing = map.get(runId);
      if (!existing) {
        return [undefined, map] as const;
      }
      const next = new Map(map);
      next.set(runId, updater(existing));
      return [undefined, next] as const;
    }).pipe(Effect.asVoid);
  }

  private publishEvent(event: RunnerEvent): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      for (const entry of this.listeners) {
        if (entry.runId && entry.runId !== event.runId) {
          continue;
        }
        entry.listener(event);
      }
    }).pipe(
      Effect.flatMap(() => PubSub.publish(this.eventBus, event)),
      Effect.asVoid,
    );
  }
}
