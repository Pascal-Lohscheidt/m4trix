import { render } from 'ink';
import * as React from 'react';
import {
  type EvaluatorLogEntry,
  formatScoreData,
  getDiffLines,
  getEvaluatorDisplayLabel,
  getLogLines,
  getMetricById,
  getScoreById,
  type LogEntry,
} from '../evals';
import type { ScoreItem } from '../evals/score';
import type { RunnerApi, RunnerEvent } from '../runner';
import {
  aggregateMetricItems,
  aggregateScoreItems,
  toNumericScore,
  toNumericScoreFromScores,
} from '../runner/score-utils';
import { RunView } from './views/RunView';

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

interface TestCaseScoreSummary {
  name: string;
  averageScore?: number;
  stdDev?: number;
  aggregatedScoreItem?: ScoreItem;
  isAggregated: boolean;
  durationMs: number;
  passed: boolean;
}

interface TestCaseEventAcc {
  name: string;
  events: Array<{
    averageScore?: number;
    passed: boolean;
    durationMs: number;
    evaluatorScores: ReadonlyArray<{
      evaluatorId: string;
      scores: ReadonlyArray<ScoreItem>;
      passed: boolean;
      metrics?: ReadonlyArray<{ id: string; data: unknown }>;
      logs?: ReadonlyArray<EvaluatorLogEntry>;
    }>;
  }>;
}

function buildTestCaseSummaries(byId: Map<string, TestCaseEventAcc>): TestCaseScoreSummary[] {
  const summaries: TestCaseScoreSummary[] = [];
  for (const { name, events } of byId.values()) {
    const passed = events.every((e) => e.passed);
    const durationMs = events.reduce((sum, e) => sum + e.durationMs, 0);
    const isAggregated = events.length > 1;
    const allScores = events.flatMap((ev) =>
      ev.evaluatorScores
        .map((es) => toNumericScoreFromScores(es.scores))
        .filter((n): n is number => n !== undefined),
    );
    const averageScore =
      allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : undefined;
    const sumSq = allScores.length > 0 ? allScores.reduce((s, v) => s + v * v, 0) : 0;
    const total = allScores.reduce((a, b) => a + b, 0);
    const stdDev = sampleStdDev(total, sumSq, allScores.length);
    let firstAggregatedScore: ScoreItem | undefined;
    for (const evaluatorScores of events[0]?.evaluatorScores ?? []) {
      const scoreIdToItems = new Map<string, ScoreItem[]>();
      for (const ev of events) {
        const es = ev.evaluatorScores.find((x) => x.evaluatorId === evaluatorScores.evaluatorId);
        for (const s of es?.scores ?? []) {
          const list = scoreIdToItems.get(s.id) ?? [];
          list.push(s);
          scoreIdToItems.set(s.id, list);
        }
      }
      for (const items of scoreIdToItems.values()) {
        const agg = aggregateScoreItems(items);
        if (agg && firstAggregatedScore === undefined) {
          firstAggregatedScore = agg;
          break;
        }
      }
      if (firstAggregatedScore !== undefined) break;
    }
    summaries.push({
      name,
      averageScore,
      stdDev: stdDev ?? undefined,
      aggregatedScoreItem: firstAggregatedScore,
      isAggregated,
      durationMs,
      passed,
    });
  }
  return summaries;
}

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

function colorize(text: string, color: string): string {
  return `${color}${text}${ansi.reset}`;
}

function scoreToColor(score: number): string {
  if (score >= 80) {
    return ansi.green;
  }
  if (score >= 50) {
    return ansi.yellow;
  }
  return ansi.red;
}

function getEvaluatorSummaryLines(
  evaluatorId: string,
  evaluatorName: string,
  aggregate: EvaluatorAggregate | undefined,
  scoreItemsByKey: Map<string, ScoreItem[]>,
): string[] {
  const lines: string[] = [];
  const scoreKeys = [...scoreItemsByKey.keys()].filter((k) => k.startsWith(`${evaluatorId}:`));
  if (scoreKeys.length === 0) {
    lines.push(`- ${evaluatorName.padEnd(28)} no scores`);
    return lines;
  }
  const passedFailed =
    aggregate != null ? ` passed=${aggregate.passed} failed=${aggregate.failed}` : '';
  const scoreLines: string[] = [];
  for (const key of scoreKeys) {
    const items = scoreItemsByKey.get(key) ?? [];
    const agg = aggregateScoreItems(items);
    if (!agg) continue;
    const def = agg.def ?? getScoreById(agg.id);
    const label = agg.name ?? def?.name ?? def?.id ?? agg.id;
    const formatted = def ? def.formatAggregate(agg.data) : 'n/a';
    const numeric = toNumericScore(agg.data);
    const colored = numeric !== undefined ? colorize(formatted, scoreToColor(numeric)) : formatted;
    scoreLines.push(`    ${label}: ${colored}`);
  }
  if (scoreLines.length > 0) {
    lines.push(`- ${evaluatorName.padEnd(28)}${passedFailed}`);
    lines.push(...scoreLines);
  } else {
    lines.push(`- ${evaluatorName.padEnd(28)} no numeric scores${passedFailed}`);
  }
  return lines;
}

function createBar(value: number, max = 100, width = 20): string {
  const safe = Math.max(0, Math.min(max, value));
  const filled = Math.round((safe / max) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function aggregateEvaluatorScoresFromEvents(
  events: TestCaseEventAcc['events'],
  _evaluatorNameById: Map<string, string>,
): Array<{
  evaluatorId: string;
  scores: ReadonlyArray<ScoreItem>;
  passed: boolean;
  metrics?: ReadonlyArray<{ id: string; data: unknown }>;
}> {
  if (events.length === 0) return [];
  const evaluatorIds = new Set(events.flatMap((e) => e.evaluatorScores.map((x) => x.evaluatorId)));
  const result: Array<{
    evaluatorId: string;
    scores: ReadonlyArray<ScoreItem>;
    passed: boolean;
    metrics?: ReadonlyArray<{ id: string; data: unknown }>;
  }> = [];
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
      .map(([, items]) => aggregateMetricItems(items as never))
      .filter((m): m is { id: string; data: unknown } => m !== undefined);
    const passed = events.every((ev) => {
      const es = ev.evaluatorScores.find((x) => x.evaluatorId === evaluatorId);
      return es?.passed ?? false;
    });
    result.push({
      evaluatorId,
      scores: aggregatedScores,
      passed,
      metrics: aggregatedMetrics.length > 0 ? aggregatedMetrics : undefined,
    });
  }
  return result;
}

function formatEvaluatorScoreLine(
  name: string,
  scores: ReadonlyArray<ScoreItem>,
  passed: boolean,
  metrics?: ReadonlyArray<{ id: string; data: unknown; name?: string }>,
  options?: { isAggregated?: boolean },
): string[] {
  const passLabel = passed
    ? colorize('PASS', `${ansi.bold}${ansi.green}`)
    : colorize('FAIL', `${ansi.bold}${ansi.red}`);
  const metricParts: string[] = [];
  if (metrics && metrics.length > 0) {
    for (const m of metrics) {
      const def = getMetricById(m.id);
      if (def) {
        const formatted = def.format(m.data, options);
        const label = m.name ?? def.name;
        metricParts.push(label ? `[${label}: ${formatted}]` : `[${formatted}]`);
      }
    }
  }
  const scoreLines: string[] = [];
  for (const item of scores) {
    const def = item.def ?? getScoreById(item.id);
    const scoreLabel = item.name ?? def?.name ?? def?.id ?? item.id;
    let formatted: string;
    if (!def) {
      const numeric = toNumericScore(item.data);
      formatted =
        numeric !== undefined ? colorize(numeric.toFixed(2), scoreToColor(numeric)) : 'n/a';
    } else {
      const raw = formatScoreData(def, item.data, options);
      switch (def.displayStrategy) {
        case 'bar': {
          const numeric =
            typeof item.data === 'object' && item.data !== null && 'value' in item.data
              ? (item.data as { value: unknown }).value
              : toNumericScore(item.data);
          if (typeof numeric === 'number' && Number.isFinite(numeric)) {
            formatted = `${colorize(raw, scoreToColor(numeric))} ${colorize(createBar(numeric), ansi.dim)}`;
          } else {
            formatted = raw;
          }
          break;
        }
        case 'number':
          formatted = raw;
          break;
        case 'passFail':
          formatted = colorize(
            raw,
            item.passed === true
              ? `${ansi.bold}${ansi.green}`
              : item.passed === false
                ? `${ansi.bold}${ansi.red}`
                : ansi.dim,
          );
          break;
      }
    }
    scoreLines.push(`      ${scoreLabel}: ${formatted}`);
  }
  const lines: string[] = [];
  const metricStr = metricParts.length > 0 ? ` ${metricParts.join(' ')}` : '';
  lines.push(`   ${name}: ${passLabel}${metricStr}`);
  if (scoreLines.length > 0) {
    lines.push(...scoreLines);
  } else {
    lines.push(`      n/a`);
  }
  return lines;
}

/** @returns `0` if every completed run had zero failed test cases; `1` otherwise. */
export async function runSimpleEvalRunConfigsPlain(
  runner: RunnerApi,
  runConfigNames: ReadonlyArray<string>,
  concurrency: number,
  experimentName?: string,
  triggerTimestamp?: number,
): Promise<0 | 1> {
  const jobs = await runner.expandRunConfigNamesToJobs(runConfigNames);
  if (jobs.length === 0) {
    throw new Error('No jobs expanded from RunConfigs.');
  }

  const evaluators = await runner.collectEvaluators();
  const evaluatorNameById = new Map(
    evaluators.map((item) => [item.id, getEvaluatorDisplayLabel(item.evaluator) ?? item.id]),
  );

  const aggregates = new Map<string, EvaluatorAggregate>();
  const scoreItemsByEvaluatorScore = new Map<string, ScoreItem[]>();
  const testCaseByTestId = new Map<string, TestCaseEventAcc>();
  let overallScoreTotal = 0;
  let overallScoreSumSq = 0;
  let overallScoreCount = 0;
  let globalStartedUnits = 0;
  let globalCompletedUnits = 0;
  let totalCount = 0;
  let runFinished = false;
  const inFlightRepetitions = new Set<string>();
  const spinnerFrames = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠇'];
  let spinnerIndex = 0;

  function clearLine(): void {
    if (!process.stdout.isTTY) {
      return;
    }
    process.stdout.write('\r\x1b[2K');
  }

  function cursorUp(n: number): void {
    if (!process.stdout.isTTY || n <= 0) return;
    process.stdout.write(`\x1b[${n}A`);
  }

  function drawSpinner(): void {
    if (!process.stdout.isTTY || runFinished) {
      return;
    }
    const frame = spinnerFrames[spinnerIndex % spinnerFrames.length];
    spinnerIndex += 1;
    process.stdout.write(
      `\r${colorize(frame, ansi.cyan)} Running evaluations ${colorize(
        `${globalCompletedUnits}/${totalCount}`,
        ansi.bold,
      )} completed ${colorize(`${globalStartedUnits}/${totalCount}`, ansi.bold)} started ${colorize(`(${inFlightRepetitions.size} running)`, ansi.dim)}`,
    );
  }

  let lastPrintedTestCaseId: string | null = null;
  let lastPrintedLineCount = 0;

  let spinnerTimer: NodeJS.Timeout | undefined;

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

      const rowPrefix = typeof event.runId === 'string' ? runIdToLabel.get(event.runId) : undefined;
      const pfx = rowPrefix !== undefined ? `${colorize(`[${rowPrefix}]`, ansi.dim)} ` : '';

      if (event.type === 'TestCaseStarted') {
        globalStartedUnits += 1;
        inFlightRepetitions.add(
          `${event.runId}:${event.testCaseId}:${event.repetitionId}:${event.repetitionIndex}`,
        );
        clearLine();
        process.stdout.write(
          `${pfx}${colorize(`[started ${event.startedTestCases}/${event.totalTestCases}]`, ansi.cyan)} ${event.testCaseName} ${colorize(`(${event.repetitionIndex}/${event.repetitionCount})`, ansi.cyan)} ${colorize('(running)', ansi.dim)}\n`,
        );
        drawSpinner();
      }
      if (event.type === 'TestCaseProgress') {
        globalCompletedUnits += 1;
        inFlightRepetitions.delete(
          `${event.runId}:${event.testCaseId}:${event.repetitionId}:${event.repetitionIndex}`,
        );
        const numericScores = event.evaluatorScores
          .map((item) => toNumericScoreFromScores(item.scores))
          .filter((item): item is number => item !== undefined);
        const averageScore =
          numericScores.length > 0
            ? numericScores.reduce((sum, value) => sum + value, 0) / numericScores.length
            : undefined;

        const compositeId = `${event.runId}:${event.testCaseId}`;
        const existing = testCaseByTestId.get(compositeId) ?? {
          name: event.testCaseName,
          events: [],
        };
        existing.events.push({
          averageScore,
          passed: event.passed,
          durationMs: event.durationMs,
          evaluatorScores: event.evaluatorScores,
        });
        testCaseByTestId.set(compositeId, existing);

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

        const isSameTestCase = lastPrintedTestCaseId === compositeId;
        const isLastRepetition = event.repetitionIndex >= event.repetitionCount;
        const isNonTty = !process.stdout.isTTY;
        const skipPrintNonTty = isNonTty && event.repetitionCount > 1 && !isLastRepetition;

        if (isSameTestCase && lastPrintedLineCount > 0 && !skipPrintNonTty) {
          cursorUp(lastPrintedLineCount);
        }

        const aggregatedScores = aggregateEvaluatorScoresFromEvents(
          existing.events,
          evaluatorNameById,
        );
        const isAggregated = existing.events.length > 1;
        const durationMs = existing.events.reduce((s, e) => s + e.durationMs, 0);

        const lines: string[] = [];
        const statusSuffix = event.errorMessage
          ? ` ${colorize('ERROR', `${ansi.bold}${ansi.red}`)}`
          : '';
        lines.push(
          `${pfx}${colorize(`[${event.completedTestCases}/${event.totalTestCases}]`, ansi.cyan)} ${event.testCaseName} ${colorize(`(${event.repetitionIndex}/${event.repetitionCount})`, ansi.cyan)} ${colorize(`(${durationMs}ms)`, ansi.dim)}${statusSuffix}`,
        );
        if (event.errorMessage) {
          lines.push(colorize(event.errorMessage, ansi.red));
        }
        for (const item of aggregatedScores) {
          const name = evaluatorNameById.get(item.evaluatorId) ?? item.evaluatorId;
          lines.push(
            ...formatEvaluatorScoreLine(name, item.scores, item.passed, item.metrics, {
              isAggregated,
            }),
          );
          const lastEvent = existing.events[existing.events.length - 1];
          const lastEs = lastEvent?.evaluatorScores.find((x) => x.evaluatorId === item.evaluatorId);
          if (!item.passed && lastEs?.logs && lastEs.logs.length > 0) {
            for (const log of lastEs.logs) {
              if (log.type === 'diff') {
                const useColor = process.stdout.isTTY;
                for (const { type, line } of getDiffLines(log)) {
                  const colored =
                    useColor && type === 'remove'
                      ? colorize(`      ${line}`, ansi.red)
                      : useColor && type === 'add'
                        ? colorize(`      ${line}`, ansi.green)
                        : `      ${line}`;
                  lines.push(colored);
                }
              } else if (log.type === 'log') {
                for (const line of getLogLines(log as LogEntry)) {
                  lines.push(`      ${line}`);
                }
              }
            }
          }
        }

        if (!skipPrintNonTty) {
          for (let i = 0; i < lines.length; i += 1) {
            process.stdout.write(`\r\x1b[2K${lines[i]}\n`);
          }
          lastPrintedTestCaseId = compositeId;
          lastPrintedLineCount = lines.length;
        }

        drawSpinner();
      }
      if (event.type === 'RunFailed') {
        if (batchReady && !batchPendingRunIds.has(event.runId)) {
          return;
        }
        runFinished = true;
        clearLine();
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
          runFinished = true;
          clearLine();
          unsubscribe();
          resolve();
        }
      }
    });
  });

  console.log(colorize('=== Eval Run Started (RunConfigs) ===', `${ansi.bold}${ansi.cyan}`));
  for (const name of runConfigNames) {
    const collected = await runner.resolveRunConfigByName(name);
    const label = collected?.runConfig.getDisplayLabel() ?? name;
    console.log(`RunConfig: ${colorize(label, ansi.bold)}`);
  }
  console.log(`Jobs: ${colorize(String(jobs.length), ansi.bold)}`);
  console.log(`Shared concurrency: ${colorize(String(concurrency), ansi.bold)}`);
  console.log('');

  const snapshots = await runner.runDatasetJobsWithSharedConcurrency({
    jobs,
    globalConcurrency: concurrency,
    experimentName,
    triggerTimestamp,
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
  totalCount = snapshots.reduce((sum, s) => sum + s.totalTestCases, 0);
  console.log(`Total evaluation units: ${colorize(String(totalCount), ansi.bold)}`);
  console.log('');
  batchReady = true;

  drawSpinner();
  spinnerTimer = setInterval(drawSpinner, 100);

  await done;
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
  }

  console.log('');
  console.log(colorize('=== Run Summary (all jobs) ===', `${ansi.bold}${ansi.cyan}`));
  for (const snap of snapshots) {
    const completed = completedRuns.get(snap.runId);
    if (!completed) {
      continue;
    }
    const label = runIdToLabel.get(snap.runId) ?? snap.runId;
    console.log('');
    console.log(colorize(`— ${label}`, ansi.magenta));
    console.log(
      `- passed: ${colorize(`${completed.passedTestCases}/${completed.totalTestCases}`, ansi.green)}`,
    );
    console.log(
      `- failed: ${colorize(
        `${completed.failedTestCases}/${completed.totalTestCases}`,
        completed.failedTestCases > 0 ? ansi.red : ansi.dim,
      )}`,
    );
    console.log(`- artifact: ${colorize(completed.artifactPath, ansi.dim)}`);
  }

  if (overallScoreCount > 0) {
    const overallAverage = overallScoreTotal / overallScoreCount;
    const overallSd = sampleStdDev(overallScoreTotal, overallScoreSumSq, overallScoreCount);
    const avgStr =
      overallSd !== undefined
        ? `${overallAverage.toFixed(2)} ± ${overallSd.toFixed(2)}`
        : overallAverage.toFixed(2);
    console.log('');
    console.log(
      `- overall avg score (all jobs): ${colorize(
        avgStr,
        scoreToColor(overallAverage),
      )} ${colorize(createBar(overallAverage), ansi.dim)}`,
    );
  }
  console.log(colorize('- evaluator averages:', ansi.magenta));
  for (const [evaluatorId, evaluatorName] of evaluatorNameById.entries()) {
    const evaluatorLines = getEvaluatorSummaryLines(
      evaluatorId,
      evaluatorName,
      aggregates.get(evaluatorId),
      scoreItemsByEvaluatorScore,
    );
    for (const line of evaluatorLines) {
      console.log(line);
    }
  }
  const testCaseSummaries = buildTestCaseSummaries(testCaseByTestId);
  if (testCaseSummaries.length > 0) {
    console.log(colorize('- test case scores:', ansi.magenta));
    for (const summary of testCaseSummaries) {
      const status = summary.passed ? colorize('PASS', ansi.green) : colorize('FAIL', ansi.red);
      if (summary.averageScore === undefined) {
        console.log(
          `  ${status} ${summary.name.padEnd(24)} score=n/a ${colorize(`(${summary.durationMs}ms)`, ansi.dim)}`,
        );
        continue;
      }
      const scoreLabel =
        summary.isAggregated && summary.aggregatedScoreItem
          ? (() => {
              const def =
                summary.aggregatedScoreItem.def ?? getScoreById(summary.aggregatedScoreItem.id);
              return def
                ? def.formatAggregate(summary.aggregatedScoreItem.data)
                : summary.averageScore!.toFixed(2);
            })()
          : summary.stdDev !== undefined && summary.isAggregated
            ? `${summary.averageScore.toFixed(2)} ± ${summary.stdDev.toFixed(2)}`
            : summary.averageScore.toFixed(2);
      console.log(
        `  ${status} ${summary.name.padEnd(24)} score=${colorize(
          scoreLabel,
          scoreToColor(summary.averageScore),
        )} ${colorize(createBar(summary.averageScore, 100, 14), ansi.dim)} ${colorize(`(${summary.durationMs}ms)`, ansi.dim)}`,
      );
    }
  }

  let failedTestCasesTotal = 0;
  for (const snap of snapshots) {
    const completed = completedRuns.get(snap.runId);
    if (completed) {
      failedTestCasesTotal += completed.failedTestCases;
    }
  }
  return failedTestCasesTotal > 0 ? 1 : 0;
}

export async function runSimpleEvalRunConfigsInk(
  runner: RunnerApi,
  runConfigNames: ReadonlyArray<string>,
  concurrency: number,
  experimentName?: string,
  triggerTimestamp?: number,
): Promise<0 | 1> {
  return new Promise<0 | 1>((resolve, reject) => {
    const app = render(
      React.createElement(RunView, {
        runner,
        runConfigNames,
        concurrency,
        experimentName,
        triggerTimestamp,
        onComplete: (err?: Error, exitCode?: 0 | 1) => {
          app.unmount();
          if (err) {
            reject(err);
          } else {
            resolve(exitCode ?? 0);
          }
        },
      }),
    );
  });
}
