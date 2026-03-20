import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { RunnerConfig } from './config';
import type { RunSnapshot } from './events';

export interface ParsedTestCaseProgress {
  testCaseId: string;
  testCaseName: string;
  completedTestCases: number;
  totalTestCases: number;
  repetitionId?: string;
  repetitionIndex?: number;
  repetitionCount?: number;
  passed: boolean;
  durationMs: number;
  evaluatorScores: ReadonlyArray<{
    evaluatorId: string;
    scores: ReadonlyArray<{
      id: string;
      data: unknown;
      passed?: boolean;
      name?: string;
    }>;
    passed: boolean;
    metrics?: ReadonlyArray<{ id: string; data: unknown; name?: string }>;
    logs?: ReadonlyArray<
      | { type: 'diff'; label?: string; expected: unknown; actual: unknown; diff: string }
      | { type: 'log'; label?: string; message: string }
    >;
  }>;
}

export async function loadRunSnapshotsFromArtifacts(config: RunnerConfig): Promise<RunSnapshot[]> {
  const baseDir = resolve(config.artifactDirectory);
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((name) => name.endsWith('.jsonl'));
  const snapshots: RunSnapshot[] = [];

  for (const fileName of jsonlFiles) {
    const filePath = join(baseDir, fileName);
    try {
      const snapshot = await parseArtifactToSnapshot(filePath, config);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    } catch {
      // Skip malformed or unreadable files
    }
  }

  return snapshots.sort((a, b) => b.queuedAt - a.queuedAt);
}

async function parseArtifactToSnapshot(
  filePath: string,
  _config: RunnerConfig,
): Promise<RunSnapshot | null> {
  const content = await readFile(filePath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  let runQueued: {
    runId: string;
    datasetId: string;
    datasetName: string;
    evaluatorIds: ReadonlyArray<string>;
    totalTestCases: number;
    artifactPath: string;
    ts?: number;
  } | null = null;

  let runCompleted: {
    passedTestCases: number;
    failedTestCases: number;
    totalTestCases: number;
    finishedAt: number;
  } | null = null;

  let runFailed: { finishedAt: number; errorMessage: string } | null = null;
  let runStarted: { startedAt: number } | null = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = event.type as string;

      if (type === 'RunQueued') {
        runQueued = {
          runId: event.runId as string,
          datasetId: event.datasetId as string,
          datasetName: event.datasetName as string,
          evaluatorIds: event.evaluatorIds as ReadonlyArray<string>,
          totalTestCases: (event.totalTestCases as number) ?? 0,
          artifactPath: (event.artifactPath as string) ?? filePath,
          ts: event.ts as number | undefined,
        };
      }
      if (type === 'RunStarted') {
        runStarted = { startedAt: event.startedAt as number };
      }
      if (type === 'RunCompleted') {
        runCompleted = {
          passedTestCases: event.passedTestCases as number,
          failedTestCases: event.failedTestCases as number,
          totalTestCases: event.totalTestCases as number,
          finishedAt: event.finishedAt as number,
        };
      }
      if (type === 'RunFailed') {
        runFailed = {
          finishedAt: event.finishedAt as number,
          errorMessage: event.errorMessage as string,
        };
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (!runQueued) {
    return null;
  }

  const artifactPath = filePath;

  const status = runFailed
    ? 'failed'
    : runCompleted
      ? 'completed'
      : runStarted
        ? 'running'
        : 'queued';

  const progress = aggregateTestCaseProgress(lines);
  const completedTestCases = runCompleted ? runQueued.totalTestCases : progress.completedTestCases;
  const passedTestCases = runCompleted?.passedTestCases ?? progress.passedTestCases;
  const failedTestCases = runCompleted?.failedTestCases ?? progress.failedTestCases;

  return {
    runId: runQueued.runId,
    datasetId: runQueued.datasetId,
    datasetName: runQueued.datasetName,
    evaluatorIds: runQueued.evaluatorIds,
    queuedAt: runQueued.ts ?? 0,
    startedAt: runStarted?.startedAt,
    finishedAt: runCompleted?.finishedAt ?? runFailed?.finishedAt,
    totalTestCases: runQueued.totalTestCases,
    completedTestCases,
    passedTestCases,
    failedTestCases,
    status,
    artifactPath,
    errorMessage: runFailed?.errorMessage,
  };
}

function aggregateTestCaseProgress(lines: string[]): {
  completedTestCases: number;
  passedTestCases: number;
  failedTestCases: number;
} {
  let completedTestCases = 0;
  const testCasePassedBy = new Map<string, boolean>();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === 'TestCaseProgress') {
        const ev = event as {
          testCaseId: string;
          completedTestCases: number;
          passed: boolean;
        };
        completedTestCases = ev.completedTestCases ?? completedTestCases;
        const id = ev.testCaseId;
        const current = testCasePassedBy.get(id);
        testCasePassedBy.set(id, current === undefined ? ev.passed : current && ev.passed);
      }
    } catch {
      // skip
    }
  }
  let passedTestCases = 0;
  let failedTestCases = 0;
  for (const passed of testCasePassedBy.values()) {
    if (passed) {
      passedTestCases += 1;
    } else {
      failedTestCases += 1;
    }
  }
  return { completedTestCases, passedTestCases, failedTestCases };
}

export async function parseArtifactFile(artifactPath: string): Promise<ParsedTestCaseProgress[]> {
  try {
    const content = await readFile(artifactPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const results: ParsedTestCaseProgress[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'TestCaseProgress') {
          const ev = event as {
            testCaseId: string;
            testCaseName: string;
            completedTestCases: number;
            totalTestCases: number;
            repetitionId?: string;
            repetitionIndex?: number;
            repetitionCount?: number;
            rerunIndex?: number;
            rerunTotal?: number;
            passed: boolean;
            durationMs: number;
            evaluatorScores: ReadonlyArray<{
              evaluatorId: string;
              scores: ReadonlyArray<{
                id: string;
                data: unknown;
                passed?: boolean;
                name?: string;
              }>;
              passed: boolean;
              metrics?: ReadonlyArray<{ id: string; data: unknown; name?: string }>;
              logs?: ReadonlyArray<
                | { type: 'diff'; label?: string; expected: unknown; actual: unknown; diff: string }
                | { type: 'log'; label?: string; message: string }
              >;
            }>;
          };
          const repetitionIndex = ev.repetitionIndex ?? ev.rerunIndex;
          const repetitionCount = ev.repetitionCount ?? ev.rerunTotal;
          results.push({
            testCaseId: ev.testCaseId,
            testCaseName: ev.testCaseName,
            completedTestCases: ev.completedTestCases,
            totalTestCases: ev.totalTestCases,
            repetitionId: ev.repetitionId,
            repetitionIndex,
            repetitionCount,
            passed: ev.passed,
            durationMs: ev.durationMs,
            evaluatorScores: ev.evaluatorScores ?? [],
          });
        }
      } catch {
        // skip malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}
