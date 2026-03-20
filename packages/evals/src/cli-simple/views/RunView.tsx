/** @jsxImportSource react */

import { Box, Text } from 'ink';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { TextBar } from '../../cli/components/TextBar';
import {
  formatScoreData,
  getDiffLines,
  getEvaluatorDisplayLabel,
  getLogLines,
  getMetricById,
  getScoreById,
} from '../../evals';
import type { EvaluatorLogEntry } from '../../evals/diff';
import type { ScoreItem } from '../../evals/score';
import type { RunDatasetJob, RunnerApi, RunnerEvent } from '../../runner';
import {
  aggregateMetricItems,
  aggregateScoreItems,
  toNumericScore,
  toNumericScoreFromScores,
} from '../../runner/score-utils';
import { Banner } from './Banner';
import { Spinner } from './Spinner';

interface EvaluatorScoreRow {
  evaluatorId: string;
  evaluatorName: string;
  scores: ReadonlyArray<ScoreItem>;
  passed: boolean;
  metrics?: ReadonlyArray<{ id: string; data: unknown; name?: string }>;
  logs?: ReadonlyArray<EvaluatorLogEntry>;
}

/** One displayed block per unique test case, updated in place as repetitions complete */
interface TestCaseDisplay {
  name: string;
  testCaseId: string;
  completedTestCases: number;
  totalTestCases: number;
  repetitionIndex: number;
  repetitionCount: number;
  durationMs: number;
  passed: boolean;
  errorMessage?: string;
  events: Array<{
    evaluatorScores: EvaluatorScoreRow[];
    passed: boolean;
    durationMs: number;
  }>;
  aggregatedEvaluatorScores: EvaluatorScoreRow[];
  isAggregated: boolean;
}

interface RunningEvaluationDisplay {
  runId?: string;
  testCaseId: string;
  name: string;
  repetitionId: string;
  repetitionIndex: number;
  repetitionCount: number;
  startedTestCases: number;
  totalTestCases: number;
}

interface EvaluatorAggregate {
  total: number;
  sumSq: number;
  count: number;
  passed: number;
  failed: number;
}

function sampleStdDev(sum: number, sumSq: number, n: number): number | undefined {
  if (n < 2) return undefined;
  const mean = sum / n;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  return variance > 0 ? Math.sqrt(variance) : 0;
}

function scoreColor(score: number): 'green' | 'yellow' | 'red' {
  if (score >= 80) return 'green';
  if (score >= 50) return 'yellow';
  return 'red';
}

function createBar(value: number, max = 100, width = 20): string {
  const safe = Math.max(0, Math.min(max, value));
  const filled = Math.round((safe / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function aggregateEvaluatorScores(
  events: Array<{ evaluatorScores: EvaluatorScoreRow[] }>,
  nameById: Map<string, string>,
): EvaluatorScoreRow[] {
  if (events.length === 0) return [];
  const evaluatorIds = new Set(events.flatMap((e) => e.evaluatorScores.map((x) => x.evaluatorId)));
  const result: EvaluatorScoreRow[] = [];
  for (const evaluatorId of evaluatorIds) {
    const scoreIdToItems = new Map<string, ScoreItem[]>();
    const metricIdToItems = new Map<string, Array<{ id: string; data: unknown }>>();
    for (const ev of events) {
      const es = ev.evaluatorScores.find((x) => x.evaluatorId === evaluatorId);
      for (const s of es?.scores ?? []) {
        const list = scoreIdToItems.get(s.id) ?? [];
        list.push(s);
        scoreIdToItems.set(s.id, list);
      }
      for (const m of es?.metrics ?? []) {
        const list = metricIdToItems.get(m.id) ?? [];
        list.push(m);
        metricIdToItems.set(m.id, list);
      }
    }
    const aggregatedScores: ScoreItem[] = [];
    for (const items of scoreIdToItems.values()) {
      const agg = aggregateScoreItems(items);
      if (agg) aggregatedScores.push(agg);
    }
    const aggregatedMetrics = Array.from(metricIdToItems.entries())
      .map(([, items]) => aggregateMetricItems(items))
      .filter((m): m is { id: string; data: unknown } => m !== undefined);
    const passed = events.every((ev) => {
      const es = ev.evaluatorScores.find((x) => x.evaluatorId === evaluatorId);
      return es?.passed ?? false;
    });
    const lastEvent = events[events.length - 1];
    const lastEs = lastEvent?.evaluatorScores.find((x) => x.evaluatorId === evaluatorId);
    result.push({
      evaluatorId,
      evaluatorName: nameById.get(evaluatorId) ?? evaluatorId,
      scores: aggregatedScores,
      passed,
      metrics: aggregatedMetrics.length > 0 ? aggregatedMetrics : undefined,
      logs: lastEs?.logs,
    });
  }
  return result;
}

function formatScorePart(
  item: ScoreItem,
  _scoreToColor: (n: number) => 'green' | 'yellow' | 'red',
  options?: { isAggregated?: boolean },
): string {
  const def = item.def ?? getScoreById(item.id);
  if (!def) {
    const numeric = toNumericScore(item.data);
    return numeric !== undefined ? `${numeric.toFixed(2)}` : 'n/a';
  }
  const formatted = formatScoreData(def, item.data, options);
  if (def.displayStrategy === 'bar') {
    const numeric =
      typeof item.data === 'object' && item.data !== null && 'value' in item.data
        ? (item.data as { value: unknown }).value
        : toNumericScore(item.data);
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
      return `${formatted} ${createBar(numeric)}`;
    }
  }
  return formatted;
}

interface RunViewProps {
  runner: RunnerApi;
  runConfigNames: ReadonlyArray<string>;
  concurrency: number;
  onComplete: (error?: Error) => void;
}

interface RunInfoState {
  names: string[];
  jobs: number;
  totalTestCases: number;
}

export function RunView({
  runner,
  runConfigNames,
  concurrency,
  onComplete,
}: RunViewProps): ReactNode {
  const [phase, setPhase] = useState<'loading' | 'running' | 'completed'>('loading');
  const [runInfo, setRunInfo] = useState<RunInfoState | null>(null);
  const [testCases, setTestCases] = useState<TestCaseDisplay[]>([]);
  const [startedEvaluations, setStartedEvaluations] = useState(0);
  const [completedEvaluations, setCompletedEvaluations] = useState(0);
  const [runningEvaluations, setRunningEvaluations] = useState<RunningEvaluationDisplay[]>([]);
  const [summary, setSummary] = useState<{
    passedTestCases: number;
    failedTestCases: number;
    totalTestCases: number;
    overallScoreTotal: number;
    overallScoreSumSq: number;
    overallScoreCount: number;
    aggregates: Map<string, EvaluatorAggregate>;
    scoreItemsByEvaluatorScore: Map<string, ScoreItem[]>;
    artifactPath: string;
  } | null>(null);
  const [evaluatorNameById, setEvaluatorNameById] = useState<Map<string, string>>(new Map());

  const runEval = useCallback(async () => {
    const rcList = runConfigNames.filter((n) => n.trim().length > 0);
    if (rcList.length === 0) {
      onComplete(new Error('At least one RunConfig name is required.'));
      return;
    }

    setStartedEvaluations(0);
    setCompletedEvaluations(0);
    setTestCases([]);
    setRunningEvaluations([]);
    setSummary(null);

    let jobs: ReadonlyArray<RunDatasetJob>;
    try {
      jobs = await runner.expandRunConfigNamesToJobs(rcList);
    } catch (err) {
      onComplete(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (jobs.length === 0) {
      onComplete(new Error('No jobs expanded from RunConfigs.'));
      return;
    }

    const allEvaluators = await runner.collectEvaluators();
    const nameById = new Map(
      allEvaluators.map((item) => [item.id, getEvaluatorDisplayLabel(item.evaluator) ?? item.id]),
    );
    setEvaluatorNameById(nameById);

    const aggregates = new Map<string, EvaluatorAggregate>();
    const scoreItemsByEvaluatorScore = new Map<string, ScoreItem[]>();
    let overallScoreTotal = 0;
    let overallScoreSumSq = 0;
    let overallScoreCount = 0;

    const batchPendingRunIds = new Set<string>();
    const runIdToLabel = new Map<string, string>();
    let batchReady = false;
    const completedRuns = new Map<string, Extract<RunnerEvent, { type: 'RunCompleted' }>>();

    const done = new Promise<void>((resolve, reject) => {
      const unsubscribe = runner.subscribeRunEvents((event) => {
        if (
          batchReady &&
          'runId' in event &&
          typeof event.runId === 'string' &&
          !batchPendingRunIds.has(event.runId)
        ) {
          return;
        }

        if (event.type === 'TestCaseStarted') {
          setStartedEvaluations((c) => c + 1);
          setRunningEvaluations((prev) => {
            const withoutDuplicate = prev.filter(
              (item) =>
                !(
                  item.testCaseId === event.testCaseId &&
                  item.repetitionIndex === event.repetitionIndex &&
                  item.runId === event.runId
                ),
            );
            return [
              ...withoutDuplicate,
              {
                runId: event.runId,
                testCaseId: event.testCaseId,
                name: event.testCaseName,
                repetitionId: event.repetitionId,
                repetitionIndex: event.repetitionIndex,
                repetitionCount: event.repetitionCount,
                startedTestCases: event.startedTestCases,
                totalTestCases: event.totalTestCases,
              },
            ];
          });
        }

        if (event.type === 'TestCaseProgress') {
          for (const item of event.evaluatorScores) {
            const numeric = toNumericScoreFromScores(item.scores);
            if (numeric !== undefined) {
              const current = aggregates.get(item.evaluatorId) ?? {
                total: 0,
                sumSq: 0,
                count: 0,
                passed: 0,
                failed: 0,
              };
              aggregates.set(item.evaluatorId, {
                total: current.total + numeric,
                sumSq: current.sumSq + numeric * numeric,
                count: current.count + 1,
                passed: current.passed + (item.passed ? 1 : 0),
                failed: current.failed + (item.passed ? 0 : 1),
              });
              overallScoreTotal += numeric;
              overallScoreSumSq += numeric * numeric;
              overallScoreCount += 1;
            }
            for (const s of item.scores) {
              const key = `${item.evaluatorId}:${s.id}`;
              const list = scoreItemsByEvaluatorScore.get(key) ?? [];
              list.push(s);
              scoreItemsByEvaluatorScore.set(key, list);
            }
          }

          const label = runIdToLabel.get(event.runId);
          const compositeId = `${event.runId}:${event.testCaseId}`;
          const displayName =
            label !== undefined ? `${label} › ${event.testCaseName}` : event.testCaseName;

          setTestCases((prev) => {
            const byId = new Map(prev.map((tc) => [tc.testCaseId, tc]));
            const existing = byId.get(compositeId);
            const newEvent = {
              evaluatorScores: event.evaluatorScores.map((item) => ({
                evaluatorId: item.evaluatorId,
                evaluatorName: nameById.get(item.evaluatorId) ?? item.evaluatorId,
                scores: item.scores,
                passed: item.passed,
                metrics: item.metrics,
                logs: item.logs,
              })),
              passed: event.passed,
              durationMs: event.durationMs,
            };
            const events = existing ? [...existing.events, newEvent] : [newEvent];
            const isAggregated = events.length > 1;
            const aggregatedEvaluatorScores = aggregateEvaluatorScores(events, nameById);
            const merged: TestCaseDisplay = {
              name: displayName,
              testCaseId: compositeId,
              completedTestCases: event.completedTestCases,
              totalTestCases: event.totalTestCases,
              repetitionIndex: event.repetitionIndex,
              repetitionCount: event.repetitionCount,
              durationMs: events.reduce((s, e) => s + e.durationMs, 0),
              passed: events.every((e) => e.passed),
              errorMessage: event.errorMessage,
              events,
              aggregatedEvaluatorScores,
              isAggregated,
            };
            byId.set(compositeId, merged);
            return Array.from(byId.values());
          });
          setCompletedEvaluations((c) => c + 1);
          setRunningEvaluations((running) =>
            running.filter(
              (item) =>
                !(
                  item.testCaseId === event.testCaseId &&
                  item.repetitionIndex === event.repetitionIndex &&
                  item.runId === event.runId
                ),
            ),
          );
        }

        if (event.type === 'RunFailed') {
          if (batchReady && !batchPendingRunIds.has(event.runId)) {
            return;
          }
          unsubscribe();
          reject(new Error(`Run failed: ${event.errorMessage}`));
          return;
        }

        if (event.type === 'RunCompleted') {
          if (!batchPendingRunIds.has(event.runId)) {
            return;
          }
          completedRuns.set(event.runId, event);
          batchPendingRunIds.delete(event.runId);
          if (batchPendingRunIds.size === 0) {
            unsubscribe();
            resolve();
          }
        }
      });
    });

    const snapshots = await runner.runDatasetJobsWithSharedConcurrency({
      jobs,
      globalConcurrency: concurrency,
    });
    for (let i = 0; i < snapshots.length; i += 1) {
      const snap = snapshots[i];
      const job = jobs[i];
      if (snap && job) {
        runIdToLabel.set(
          snap.runId,
          `${job.runConfigDisplayLabel ?? job.runConfigName} · ${snap.datasetName}`,
        );
        batchPendingRunIds.add(snap.runId);
      }
    }
    const totalUnits = snapshots.reduce((sum, s) => sum + s.totalTestCases, 0);
    batchReady = true;

    const runConfigLabels = await Promise.all(
      rcList.map(async (n) => {
        const collected = await runner.resolveRunConfigByName(n);
        return collected?.runConfig.getDisplayLabel() ?? n;
      }),
    );

    setRunInfo({
      names: runConfigLabels,
      jobs: jobs.length,
      totalTestCases: totalUnits,
    });
    setPhase('running');

    try {
      await done;
    } catch (err) {
      onComplete(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let passedTestCases = 0;
    let failedTestCases = 0;
    let totalTestCases = 0;
    const artifacts: string[] = [];
    for (const ev of completedRuns.values()) {
      passedTestCases += ev.passedTestCases;
      failedTestCases += ev.failedTestCases;
      totalTestCases += ev.totalTestCases;
      artifacts.push(ev.artifactPath);
    }

    setSummary({
      passedTestCases,
      failedTestCases,
      totalTestCases,
      overallScoreTotal,
      overallScoreSumSq,
      overallScoreCount,
      aggregates: new Map(aggregates),
      scoreItemsByEvaluatorScore: new Map(scoreItemsByEvaluatorScore),
      artifactPath: artifacts.join('\n'),
    });
    setPhase('completed');
    setTimeout(() => onComplete(), 200);
  }, [runner, runConfigNames, concurrency, onComplete]);

  useEffect(() => {
    void runEval();
  }, [runEval]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Banner />
      </Box>

      {runInfo && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan" bold>
            RunConfigs{' '}
          </Text>
          <Text color="gray">{runInfo.names.join(', ')}</Text>
          <Text>
            <Text color="cyan" bold>
              Jobs{' '}
            </Text>
            {runInfo.jobs}
          </Text>
          <Text>
            <Text color="cyan" bold>
              Evaluation units{' '}
            </Text>
            {runInfo.totalTestCases}
          </Text>
        </Box>
      )}

      {phase === 'running' && (
        <Box flexDirection="column" marginBottom={1}>
          <Spinner
            label={`Evaluations ${completedEvaluations}/${runInfo?.totalTestCases ?? 0} completed • ${startedEvaluations}/${runInfo?.totalTestCases ?? 0} started`}
          />
          {runningEvaluations.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {runningEvaluations.map((item) => (
                <Text
                  key={`${item.runId ?? ''}:${item.testCaseId}:${item.repetitionId}:${item.repetitionIndex}`}
                  color="yellow"
                >
                  [running {item.startedTestCases}/{item.totalTestCases}] {item.name}{' '}
                  <Text color="gray">
                    ({item.repetitionIndex}/{item.repetitionCount})
                  </Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {testCases.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {testCases.map((tc) => (
            <Box key={tc.testCaseId} flexDirection="column" marginBottom={0}>
              <Text>
                <Text color="cyan">
                  [{tc.completedTestCases}/{tc.totalTestCases}]
                </Text>{' '}
                {tc.name}{' '}
                <Text color="cyan">
                  ({tc.repetitionIndex}/{tc.repetitionCount})
                </Text>
                <Text color="gray"> ({tc.durationMs}ms)</Text>
                {tc.errorMessage ? (
                  <Text color="red" bold>
                    {' '}
                    ERROR
                  </Text>
                ) : null}
              </Text>
              {tc.errorMessage ? <Text color="red">{tc.errorMessage}</Text> : null}
              {tc.aggregatedEvaluatorScores.map((item) => (
                <Box key={item.evaluatorId} flexDirection="column" marginLeft={2}>
                  <Text>
                    {item.evaluatorName}:{' '}
                    <Text color={item.passed ? 'green' : 'red'} bold>
                      {item.passed ? 'PASS' : 'FAIL'}
                    </Text>
                    {item.metrics && item.metrics.length > 0 ? (
                      <>
                        {' '}
                        {item.metrics.map((m) => {
                          const def = getMetricById(m.id);
                          if (!def) return null;
                          const formatted = def.format(m.data, {
                            isAggregated: tc.isAggregated,
                          });
                          const label = m.name ?? def.name;
                          return (
                            <Text key={m.id} color="gray">
                              [{label ? `${label}: ` : ''}
                              {formatted}]{' '}
                            </Text>
                          );
                        })}
                      </>
                    ) : null}
                  </Text>
                  {item.scores.length > 0 ? (
                    item.scores.map((s) => {
                      const def = s.def ?? getScoreById(s.id);
                      const scoreLabel = s.name ?? def?.name ?? def?.id ?? s.id;
                      return (
                        <Text
                          key={`${item.evaluatorId}-${s.id}-${scoreLabel}`}
                          color={scoreColor(toNumericScore(s.data) ?? 0)}
                        >
                          {'      '}
                          {scoreLabel}:{' '}
                          {formatScorePart(s, scoreColor, {
                            isAggregated: tc.isAggregated,
                          })}
                        </Text>
                      );
                    })
                  ) : (
                    <Text color="gray"> n/a</Text>
                  )}
                  {!item.passed && item.logs && item.logs.length > 0 && (
                    <Box marginLeft={2} flexDirection="column">
                      {item.logs.map((log) =>
                        log.type === 'diff' ? (
                          <Box
                            key={`diff:${getDiffLines(log)
                              .map((x) => x.line)
                              .join('|')}`}
                            flexDirection="column"
                          >
                            {getDiffLines(log).map(({ type, line }) => (
                              <Text
                                key={`${type}:${line}`}
                                color={
                                  type === 'remove' ? 'red' : type === 'add' ? 'green' : 'gray'
                                }
                              >
                                {line}
                              </Text>
                            ))}
                          </Box>
                        ) : log.type === 'log' ? (
                          <Box key={`log:${getLogLines(log).join('\n')}`} flexDirection="column">
                            {getLogLines(log).map((line) => (
                              <Text key={line} color="gray">
                                {line}
                              </Text>
                            ))}
                          </Box>
                        ) : null,
                      )}
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )}

      {phase === 'completed' && summary && (
        <Box flexDirection="column">
          <Text color="cyan" bold>
            Run Summary
          </Text>
          <Box marginTop={1}>
            <Text color="green">passed</Text>
            <Text>
              {' '}
              {summary.passedTestCases}/{summary.totalTestCases}
            </Text>
          </Box>
          <Box>
            <Text color={summary.failedTestCases > 0 ? 'red' : 'gray'}>failed</Text>
            <Text>
              {' '}
              {summary.failedTestCases}/{summary.totalTestCases}
            </Text>
          </Box>
          {summary.overallScoreCount > 0 && (
            <Box marginTop={1}>
              <TextBar
                label="overall avg"
                value={summary.overallScoreTotal / summary.overallScoreCount}
                barWidth={20}
                format={(v) => {
                  const sd = sampleStdDev(
                    summary.overallScoreTotal,
                    summary.overallScoreSumSq,
                    summary.overallScoreCount,
                  );
                  return sd !== undefined ? `${v.toFixed(2)} ± ${sd.toFixed(2)}` : v.toFixed(2);
                }}
              />
            </Box>
          )}
          <Box marginTop={1} flexDirection="column">
            <Text color="magenta">evaluator averages</Text>
            {Array.from(evaluatorNameById.entries()).map(([id, name]) => {
              const agg = summary.aggregates.get(id);
              const scoreKeys = [...(summary.scoreItemsByEvaluatorScore?.keys() ?? [])].filter(
                (k) => k.startsWith(`${id}:`),
              );
              if (scoreKeys.length === 0) {
                return (
                  <Text key={id} color="gray">
                    - {name.padEnd(28)} no scores
                  </Text>
                );
              }
              const passedFailed =
                agg != null ? (
                  <Text>
                    {' '}
                    passed={agg.passed} failed={agg.failed}
                  </Text>
                ) : null;
              return (
                <Box key={id} flexDirection="column">
                  <Text>
                    - {name.padEnd(28)}
                    {passedFailed}
                  </Text>
                  {scoreKeys.map((key) => {
                    const items = summary.scoreItemsByEvaluatorScore?.get(key) ?? [];
                    const aggregated = aggregateScoreItems(items);
                    if (!aggregated) return null;
                    const def = aggregated.def ?? getScoreById(aggregated.id);
                    const label = aggregated.name ?? def?.name ?? def?.id ?? aggregated.id;
                    const formatted = def ? def.formatAggregate(aggregated.data) : 'n/a';
                    const numeric = toNumericScore(aggregated.data);
                    return (
                      <Text key={key} color={numeric !== undefined ? scoreColor(numeric) : 'gray'}>
                        {'    '}
                        {label}: {formatted}
                      </Text>
                    );
                  })}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="magenta">test case scores</Text>
            {testCases.map((tc) => {
              const allScores = tc.events.flatMap((ev) =>
                ev.evaluatorScores
                  .map((es) => toNumericScoreFromScores(es.scores))
                  .filter((n): n is number => n !== undefined),
              );
              const averageScore =
                allScores.length > 0
                  ? allScores.reduce((a, b) => a + b, 0) / allScores.length
                  : undefined;
              const sumSq = allScores.length > 0 ? allScores.reduce((s, v) => s + v * v, 0) : 0;
              const total = allScores.reduce((a, b) => a + b, 0);
              const tcStdDev = sampleStdDev(total, sumSq, allScores.length);
              const firstScore = tc.aggregatedEvaluatorScores[0]?.scores[0];
              const scoreLabel =
                firstScore && tc.isAggregated
                  ? formatScorePart(firstScore, scoreColor, {
                      isAggregated: true,
                    })
                  : averageScore !== undefined
                    ? tcStdDev !== undefined && tc.isAggregated
                      ? `${averageScore.toFixed(2)} ± ${tcStdDev.toFixed(2)}`
                      : averageScore.toFixed(2)
                    : 'n/a';
              return (
                <Box key={tc.testCaseId}>
                  <Text color={tc.passed ? 'green' : 'red'}>{tc.passed ? 'PASS' : 'FAIL'}</Text>
                  <Text> {tc.name.padEnd(24)}</Text>
                  {averageScore !== undefined ? (
                    <>
                      <Text color={scoreColor(averageScore)}>score={scoreLabel}</Text>
                      <Text color="gray"> {createBar(averageScore, 100, 14)}</Text>
                    </>
                  ) : (
                    <Text color="gray">score=n/a</Text>
                  )}
                  <Text color="gray"> ({tc.durationMs}ms)</Text>
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">artifact(s):</Text>
            {summary.artifactPath.split('\n').map((line) => (
              <Text key={line} color="gray">
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
