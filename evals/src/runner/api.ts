import { randomUUID } from 'node:crypto';

import { Effect, Fiber, PubSub, Queue } from 'effect';

import type { RunnerConfig, RunnerConfigOverrides } from './config';
import { withRunnerConfig } from './config';
import { loadRunnerConfigFile } from './config-loader';
import {
  collectDatasetsFromFiles,
  collectEvaluatorsFromFiles,
  collectTestCasesFromFiles,
} from './discovery';
import { createArtifactPath, executeRunTask, type RunTask } from './execution';
import type {
  CollectedDataset,
  CollectedEvaluator,
  CollectedTestCase,
  RunDatasetRequest,
  RunSnapshot,
  RunnerEvent,
  SearchTestCasesQuery,
} from './events';
import { loadRunSnapshotsFromArtifacts as loadSnapshotsFromArtifacts } from './artifact-loader';
import { createPersistenceWorker } from './persistence';
import { searchCollectedTestCases } from './search';

interface SubscribeOptions {
  runId?: string;
}

function parseRegexLiteral(
  pattern: string,
): { source: string; flags: string } | undefined {
  if (!pattern.startsWith('/')) {
    return undefined;
  }
  const lastSlash = pattern.lastIndexOf('/');
  if (lastSlash <= 0) {
    return undefined;
  }
  return {
    source: pattern.slice(1, lastSlash),
    flags: pattern.slice(lastSlash + 1),
  };
}

function createNameMatcher(pattern: string): (value: string) => boolean {
  const normalizedPattern = pattern.trim();
  const regexLiteral = parseRegexLiteral(normalizedPattern);
  if (regexLiteral) {
    const regex = new RegExp(regexLiteral.source, regexLiteral.flags);
    return (value: string) => regex.test(value);
  }

  if (normalizedPattern.includes('*')) {
    const escaped = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`, 'i');
    return (value: string) => regex.test(value);
  }

  return (value: string) => value.toLowerCase() === normalizedPattern.toLowerCase();
}

export interface RunnerApi {
  collectDatasets(): Promise<ReadonlyArray<CollectedDataset>>;
  collectEvaluators(): Promise<ReadonlyArray<CollectedEvaluator>>;
  resolveDatasetByName(name: string): Promise<CollectedDataset | undefined>;
  resolveEvaluatorsByNamePattern(
    pattern: string,
  ): Promise<ReadonlyArray<CollectedEvaluator>>;
  searchTestCases(
    query?: SearchTestCasesQuery,
  ): Promise<ReadonlyArray<CollectedTestCase>>;
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
  const discovery = base.discovery || next.discovery
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

  private readonly snapshots = new Map<string, RunSnapshot>();
  private readonly listeners = new Set<{
    runId?: string;
    listener: (event: RunnerEvent) => void;
  }>();

  private readonly datasetsById = new Map<string, CollectedDataset>();

  private readonly evaluatorsById = new Map<string, CollectedEvaluator>();

  private readonly schedulerFiber = Effect.runFork(
    this.createSchedulerEffect(),
  );

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

  async searchTestCases(
    query?: SearchTestCasesQuery,
  ): Promise<ReadonlyArray<CollectedTestCase>> {
    const testCases = await collectTestCasesFromFiles(this.config.discovery);
    return searchCollectedTestCases(testCases, query);
  }

  async collectDatasetTestCases(
    datasetId: string,
  ): Promise<ReadonlyArray<CollectedTestCase>> {
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
    if (this.datasetsById.size === 0) {
      await this.collectDatasets();
    }
    if (this.evaluatorsById.size === 0) {
      await this.collectEvaluators();
    }

    const dataset = this.datasetsById.get(request.datasetId);
    if (!dataset) {
      throw new Error(`Unknown dataset: ${request.datasetId}`);
    }

    const selectedEvaluators = request.evaluatorIds
      .map((id) => this.evaluatorsById.get(id))
      .filter((value): value is CollectedEvaluator => Boolean(value))
      .map((value) => ({ id: value.id, evaluator: value.evaluator }));

    if (selectedEvaluators.length === 0) {
      throw new Error('No evaluators selected for run');
    }

    const selectedTestCases = await this.collectDatasetTestCases(request.datasetId);

    const totalEvaluations = selectedTestCases.reduce(
      (sum, tc) =>
        sum +
        (typeof tc.testCase.getReruns === 'function'
          ? tc.testCase.getReruns()
          : 1),
      0,
    );

    const triggerId = request.triggerId ?? `trg-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const artifactPath = createArtifactPath(
      this.config.artifactDirectory,
      request.datasetId,
      runId,
    );
    const snapshot: RunSnapshot = {
      runId,
      datasetId: request.datasetId,
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

    this.snapshots.set(runId, snapshot);
    const queuedEvent: RunnerEvent = {
      type: 'RunQueued',
      runId,
      datasetId: request.datasetId,
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

    const maxConcurrency =
      request.concurrency ?? this.config.maxConcurrency ?? 1;

    await Effect.runPromise(
      Queue.offer(this.runQueue, {
        runId,
        triggerId,
        datasetId: request.datasetId,
        dataset: dataset.dataset,
        evaluators: selectedEvaluators,
        testCases: selectedTestCases,
        snapshot,
        maxConcurrency,
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
    return this.snapshots.get(runId);
  }

  getAllRunSnapshots(): ReadonlyArray<RunSnapshot> {
    return Array.from(this.snapshots.values()).sort(
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
  ): void {
    const existing = this.snapshots.get(runId);
    if (!existing) {
      return;
    }
    this.snapshots.set(runId, updater(existing));
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
