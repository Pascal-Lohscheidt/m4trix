/** @jsxImportSource react */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Box, Text } from 'ink';

import {
  formatScoreData,
  getDiffLines,
  getLogLines,
  getMetricById,
  getScoreById,
} from '../../evals';
import type { EvaluatorLogEntry } from '../../evals/diff';
import type { ScoreItem } from '../../evals/score';
import type { RunnerApi, RunnerEvent } from '../../runner';
import {
  aggregateMetricItems,
  aggregateScoreItems,
  toNumericScore,
  toNumericScoreFromScores,
} from '../../runner/score-utils';
import { TextBar } from '../../cli/components/TextBar';
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

/** One displayed block per unique test case, updated in place as reruns complete */
interface TestCaseDisplay {
  name: string;
  testCaseId: string;
  completedTestCases: number;
  totalTestCases: number;
  rerunIndex: number;
  rerunTotal: number;
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
  testCaseId: string;
  name: string;
  rerunIndex: number;
  rerunTotal: number;
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
  const evaluatorIds = new Set(
    events.flatMap((e) => e.evaluatorScores.map((x) => x.evaluatorId)),
  );
  const result: EvaluatorScoreRow[] = [];
  for (const evaluatorId of evaluatorIds) {
    const scoreIdToItems = new Map<string, ScoreItem[]>();
    const metricIdToItems = new Map<
      string,
      Array<{ id: string; data: unknown }>
    >();
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
    const lastEs = lastEvent?.evaluatorScores.find(
      (x) => x.evaluatorId === evaluatorId,
    );
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
      typeof item.data === 'object' &&
      item.data !== null &&
      'value' in item.data
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
  datasetName: string;
  evaluatorPattern: string;
  onComplete: (error?: Error) => void;
}

export function RunView({
  runner,
  datasetName,
  evaluatorPattern,
  onComplete,
}: RunViewProps): ReactNode {
  const [phase, setPhase] = useState<'loading' | 'running' | 'completed'>(
    'loading',
  );
  const [runInfo, setRunInfo] = useState<{
    runId: string;
    datasetName: string;
    evaluatorNames: string[];
    totalTestCases: number;
  } | null>(null);
  const [testCases, setTestCases] = useState<TestCaseDisplay[]>([]);
  const [startedEvaluations, setStartedEvaluations] = useState(0);
  const [completedEvaluations, setCompletedEvaluations] = useState(0);
  const [runningEvaluations, setRunningEvaluations] = useState<
    RunningEvaluationDisplay[]
  >([]);
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
  const [evaluatorNameById, setEvaluatorNameById] = useState<
    Map<string, string>
  >(new Map());

  const runEval = useCallback(async () => {
    const dataset = await runner.resolveDatasetByName(datasetName);
    if (!dataset) {
      const known = await runner.collectDatasets();
      const available = known.map((item) => item.dataset.getName()).sort();
      onComplete(
        new Error(
          available.length > 0
            ? `Dataset "${datasetName}" not found. Available: ${available.join(', ')}`
            : `Dataset "${datasetName}" not found.`,
        ),
      );
      return;
    }

    const evaluators =
      await runner.resolveEvaluatorsByNamePattern(evaluatorPattern);
    if (evaluators.length === 0) {
      const known = await runner.collectEvaluators();
      const available = known
        .map((item) => item.evaluator.getName())
        .filter((name): name is string => typeof name === 'string')
        .sort();
      onComplete(
        new Error(
          available.length > 0
            ? `No evaluator matched "${evaluatorPattern}". Available: ${available.join(', ')}`
            : `No evaluator matched "${evaluatorPattern}".`,
        ),
      );
      return;
    }

    const nameById = new Map(
      evaluators.map((item) => [item.id, item.evaluator.getName() ?? item.id]),
    );
    setEvaluatorNameById(nameById);

    const aggregates = new Map<string, EvaluatorAggregate>();
    const scoreItemsByEvaluatorScore = new Map<string, ScoreItem[]>();
    let overallScoreTotal = 0;
    let overallScoreSumSq = 0;
    let overallScoreCount = 0;

    const done = new Promise<RunnerEvent>((resolve) => {
      const unsubscribe = runner.subscribeRunEvents((event) => {
        if (event.type === 'TestCaseStarted') {
          setStartedEvaluations(event.startedTestCases);
          setRunningEvaluations((prev) => {
            const withoutDuplicate = prev.filter(
              (item) =>
                !(
                  item.testCaseId === event.testCaseId &&
                  item.rerunIndex === event.rerunIndex
                ),
            );
            return [
              ...withoutDuplicate,
              {
                testCaseId: event.testCaseId,
                name: event.testCaseName,
                rerunIndex: event.rerunIndex,
                rerunTotal: event.rerunTotal,
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

          setTestCases((prev) => {
            const byId = new Map(prev.map((tc) => [tc.testCaseId, tc]));
            const existing = byId.get(event.testCaseId);
            const newEvent = {
              evaluatorScores: event.evaluatorScores.map((item) => ({
                evaluatorId: item.evaluatorId,
                evaluatorName:
                  nameById.get(item.evaluatorId) ?? item.evaluatorId,
                scores: item.scores,
                passed: item.passed,
                metrics: item.metrics,
                logs: item.logs,
              })),
              passed: event.passed,
              durationMs: event.durationMs,
            };
            const events = existing
              ? [...existing.events, newEvent]
              : [newEvent];
            const isAggregated = events.length > 1;

            const aggregatedEvaluatorScores = aggregateEvaluatorScores(
              events,
              nameById,
            );

            const merged: TestCaseDisplay = {
              name: event.testCaseName,
              testCaseId: event.testCaseId,
              completedTestCases: event.completedTestCases,
              totalTestCases: event.totalTestCases,
              rerunIndex: event.rerunIndex,
              rerunTotal: event.rerunTotal,
              durationMs: events.reduce((s, e) => s + e.durationMs, 0),
              passed: events.every((e) => e.passed),
              errorMessage: event.errorMessage,
              events,
              aggregatedEvaluatorScores,
              isAggregated,
            };
            byId.set(event.testCaseId, merged);
            setCompletedEvaluations(event.completedTestCases);
            setRunningEvaluations((running) =>
              running.filter(
                (item) =>
                  !(
                    item.testCaseId === event.testCaseId &&
                    item.rerunIndex === event.rerunIndex
                  ),
              ),
            );
            return Array.from(byId.values());
          });
        }
        if (event.type === 'RunCompleted' || event.type === 'RunFailed') {
          unsubscribe();
          resolve(event);
        }
      });
    });

    const snapshot = await runner.runDatasetWith({
      datasetId: dataset.id,
      evaluatorIds: evaluators.map((item) => item.id),
    });

    setRunInfo({
      runId: snapshot.runId,
      datasetName: snapshot.datasetName,
      evaluatorNames: evaluators.map((e) => e.evaluator.getName() ?? e.id),
      totalTestCases: snapshot.totalTestCases,
    });
    setPhase('running');

    const finalEvent = await done;

    if (finalEvent.type === 'RunFailed') {
      onComplete(new Error(`Run failed: ${finalEvent.errorMessage}`));
      return;
    }

    const completed = finalEvent as Extract<
      typeof finalEvent,
      { type: 'RunCompleted' }
    >;
    setSummary({
      passedTestCases: completed.passedTestCases,
      failedTestCases: completed.failedTestCases,
      totalTestCases: completed.totalTestCases,
      overallScoreTotal,
      overallScoreSumSq,
      overallScoreCount,
      aggregates: new Map(aggregates),
      scoreItemsByEvaluatorScore: new Map(scoreItemsByEvaluatorScore),
      artifactPath: completed.artifactPath,
    });
    setPhase('completed');
    setTimeout(() => onComplete(), 200);
  }, [runner, datasetName, evaluatorPattern, onComplete]);

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
          <Text>
            <Text color="cyan" bold>
              Run{' '}
            </Text>
            <Text color="gray">{runInfo.runId}</Text>
          </Text>
          <Text>
            <Text color="cyan" bold>
              Dataset{' '}
            </Text>
            {runInfo.datasetName}
          </Text>
          <Text>
            <Text color="cyan" bold>
              Evaluators{' '}
            </Text>
            {runInfo.evaluatorNames.join(', ')}
          </Text>
          <Text>
            <Text color="cyan" bold>
              Test cases{' '}
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
                <Text key={`${item.testCaseId}:${item.rerunIndex}`} color="yellow">
                  [running {item.startedTestCases}/{item.totalTestCases}] {item.name}{' '}
                  <Text color="gray">
                    ({item.rerunIndex}/{item.rerunTotal})
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
                  ({tc.rerunIndex}/{tc.rerunTotal})
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
                <Box
                  key={item.evaluatorId}
                  flexDirection="column"
                  marginLeft={2}
                >
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
                    item.scores.map((s, idx) => {
                      const def = s.def ?? getScoreById(s.id);
                      const scoreLabel = s.name ?? def?.name ?? def?.id ?? s.id;
                      return (
                        <Text
                          key={`${item.evaluatorId}-${s.id}-${idx}`}
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
                    <Text color="gray">      n/a</Text>
                  )}
                  {!item.passed && item.logs && item.logs.length > 0 && (
                    <Box marginLeft={2} flexDirection="column">
                      {item.logs.map((log, logIdx) =>
                        log.type === 'diff' ? (
                          <Box key={logIdx} flexDirection="column">
                            {getDiffLines(log).map(
                              ({ type, line }, lineIdx) => (
                                <Text
                                  key={lineIdx}
                                  color={
                                    type === 'remove'
                                      ? 'red'
                                      : type === 'add'
                                        ? 'green'
                                        : 'gray'
                                  }
                                >
                                  {line}
                                </Text>
                              ),
                            )}
                          </Box>
                        ) : log.type === 'log' ? (
                          <Box key={logIdx} flexDirection="column">
                            {getLogLines(log).map((line, lineIdx) => (
                              <Text key={lineIdx} color="gray">
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
            <Text color={summary.failedTestCases > 0 ? 'red' : 'gray'}>
              failed
            </Text>
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
                  return sd !== undefined
                    ? `${v.toFixed(2)} ± ${sd.toFixed(2)}`
                    : v.toFixed(2);
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
                    const items =
                      summary.scoreItemsByEvaluatorScore?.get(key) ?? [];
                    const aggregated = aggregateScoreItems(items);
                    if (!aggregated) return null;
                    const def = aggregated.def ?? getScoreById(aggregated.id);
                    const label =
                      aggregated.name ?? def?.name ?? def?.id ?? aggregated.id;
                    const formatted = def
                      ? def.formatAggregate(aggregated.data)
                      : 'n/a';
                    const numeric = toNumericScore(aggregated.data);
                    return (
                      <Text
                        key={key}
                        color={
                          numeric !== undefined
                            ? scoreColor(numeric)
                            : 'gray'
                        }
                      >
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
              const sumSq =
                allScores.length > 0
                  ? allScores.reduce((s, v) => s + v * v, 0)
                  : 0;
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
                  <Text color={tc.passed ? 'green' : 'red'}>
                    {tc.passed ? 'PASS' : 'FAIL'}
                  </Text>
                  <Text> {tc.name.padEnd(24)}</Text>
                  {averageScore !== undefined ? (
                    <>
                      <Text color={scoreColor(averageScore)}>
                        score={scoreLabel}
                      </Text>
                      <Text color="gray">
                        {' '}
                        {createBar(averageScore, 100, 14)}
                      </Text>
                    </>
                  ) : (
                    <Text color="gray">score=n/a</Text>
                  )}
                  <Text color="gray"> ({tc.durationMs}ms)</Text>
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">artifact: {summary.artifactPath}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
