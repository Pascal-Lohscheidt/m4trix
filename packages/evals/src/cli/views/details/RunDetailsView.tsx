/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { resolve } from 'node:path';
import { Box, Text } from 'ink';
import {
  formatScoreData,
  getDiffLines,
  getLogLines,
  getMetricById,
  getScoreById,
  type ScoreDef,
} from '../../../evals/index.js';
import { toNumericScore } from '../../../runner/score-utils.js';
import { parseArtifactFile, type ParsedTestCaseProgress } from '../../../runner/index.js';
import type { CliState, EvalDataset, EvalRun, EvaluatorOption } from '../../types.js';
import { Pane, RunsSidebar, SectionHeader, Sparkline, TextBar } from '../../components/index.js';

const DETAILS_PAGE_SIZE = 20;

function scoreColor(score: number): 'green' | 'yellow' | 'red' {
  if (score >= 80) return 'green';
  if (score >= 50) return 'yellow';
  return 'red';
}

function formatScorePart(item: { id: string; data: unknown; def?: ScoreDef<unknown> }): string {
  const def: ScoreDef<unknown> | undefined = item.def ?? getScoreById(item.id);
  if (!def) {
    const numeric = toNumericScore(item.data);
    return numeric !== undefined ? `${numeric.toFixed(2)}` : 'n/a';
  }
  const formatted = formatScoreData(def, item.data);
  if (def.displayStrategy === 'bar') {
    const numeric =
      typeof item.data === 'object' && item.data !== null && 'value' in item.data
        ? (item.data as { value: unknown }).value
        : toNumericScore(item.data);
    if (typeof numeric === 'number' && Number.isFinite(numeric)) {
      const barWidth = 14;
      const filled = Math.round((numeric / 100) * barWidth);
      const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
      return `${formatted} ${bar}`;
    }
  }
  return formatted;
}

interface RunDetailsViewProps {
  state: CliState;
  dataset: EvalDataset | undefined;
  selectedRun: EvalRun | undefined;
  evaluators: ReadonlyArray<EvaluatorOption>;
}

function CheckRow({
  name,
  passed,
  detail,
}: {
  name: string;
  passed: boolean;
  detail?: string;
}): React.ReactNode {
  const status = passed ? 'PASSED' : 'FAILED';
  const color = passed ? 'green' : 'red';
  return (
    <Text>
      <Text color="gray">{name.padEnd(14)}</Text>{' '}
      <Text color={color} bold>
        {status}
      </Text>
      {detail ? <Text color="gray"> ({detail})</Text> : null}
    </Text>
  );
}

function buildDetailRows(
  run: EvalRun,
  testCases: ParsedTestCaseProgress[],
  evaluatorNameById: Map<string, string>,
): React.ReactNode[] {
  const { performance, dimensions, checks, failures, meta } = run;
  const latencyHistory = performance.latencyHistoryMs ?? [
    performance.latencyAvgMs - 40,
    performance.latencyAvgMs - 10,
    performance.latencyAvgMs + 20,
    performance.latencyP95Ms - 80,
    performance.latencyP95Ms,
  ];

  const rows: React.ReactNode[] = [
    <SectionHeader key="meta-h">Meta</SectionHeader>,
    <Text key="meta-1" color="gray">
      Model: {meta.model} Provider: {meta.provider}
    </Text>,
    <Text key="meta-2" color="gray">
      Commit: {meta.commit} Branch: {meta.branch} Seed: {meta.seed}
    </Text>,
    <Text key="meta-3" color="gray">
      Duration: {meta.duration} Concurrency: {meta.concurrency}
    </Text>,
    <Text key="meta-4" color="gray">
      Artifact: {meta.artifact}
    </Text>,
    <Text key="sp1"> </Text>,
    <SectionHeader key="scores-h">Scores (0–100)</SectionHeader>,
    ...dimensions.map((d) => <TextBar key={`dim-${d.name}`} label={d.name} value={d.score} />),
    <Text key="sp2"> </Text>,
    <SectionHeader key="checks-h">Checks (boolean)</SectionHeader>,
    ...checks.map((c) => (
      <CheckRow key={`chk-${c.name}`} name={c.name} passed={c.passed} detail={c.detail} />
    )),
    <Text key="sp3"> </Text>,
    <SectionHeader key="perf-h">Performance</SectionHeader>,
    <TextBar
      key="perf-rate"
      label="pass rate"
      value={performance.passRate}
      format={(v) => `${v}%`}
    />,
    <Text key="perf-lat" color="gray">
      latency avg {performance.latencyAvgMs}ms p95 {performance.latencyP95Ms}ms
    </Text>,
    <Text key="perf-tok" color="gray">
      tokens avg {performance.tokensAvg} p95 {performance.tokensP95}
    </Text>,
    <Text key="sp4"> </Text>,
    <SectionHeader key="spark-h">Latency trend</SectionHeader>,
    <Sparkline key="spark" data={latencyHistory} width={20} />,
  ];

  if (failures.length > 0) {
    rows.push(<Text key="sp5"> </Text>);
    rows.push(<SectionHeader key="fail-h">Failures (top)</SectionHeader>);
    failures.forEach((f, i) => {
      rows.push(
        <Text key={`fail-${i}`} color="red">
          {i + 1}) {f.title}
        </Text>,
      );
    });
  }

  if (testCases.length > 0) {
    rows.push(<Text key="sp6"> </Text>);
    rows.push(<SectionHeader key="tc-h">Test cases</SectionHeader>);
    for (const tc of testCases) {
      const repetitionPart =
        tc.repetitionCount != null && tc.repetitionCount > 1 && tc.repetitionIndex != null
          ? ` (${tc.repetitionIndex}/${tc.repetitionCount})`
          : '';
      rows.push(
        <Text key={`tc-${tc.testCaseId}-${tc.repetitionId ?? 'x'}-${tc.repetitionIndex ?? 0}`}>
          <Text color="cyan">
            [{tc.completedTestCases}/{tc.totalTestCases}]
          </Text>{' '}
          {tc.testCaseName}
          {repetitionPart ? <Text color="cyan">{repetitionPart}</Text> : null}
          <Text color="gray"> ({tc.durationMs}ms)</Text>
        </Text>,
      );
      for (const item of tc.evaluatorScores) {
        const name = evaluatorNameById.get(item.evaluatorId) ?? item.evaluatorId;
        rows.push(
          <Text key={`tc-${tc.testCaseId}-${item.evaluatorId}`}>
            {'   '}
            {name}:{' '}
            <Text color={item.passed ? 'green' : 'red'} bold>
              {item.passed ? 'PASS' : 'FAIL'}
            </Text>
            {item.metrics && item.metrics.length > 0 ? (
              <>
                {' '}
                {item.metrics.map((m) => {
                  const def = getMetricById(m.id);
                  if (!def) return null;
                  const formatted = def.format(m.data);
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
          </Text>,
        );
        if (item.scores.length > 0) {
          for (let sIdx = 0; sIdx < item.scores.length; sIdx++) {
            const s = item.scores[sIdx];
            const def: ScoreDef<unknown> | undefined =
              (s as { def?: ScoreDef<unknown> }).def ?? getScoreById(s.id);
            const scoreLabel = s.name ?? def?.name ?? def?.id ?? s.id;
            rows.push(
              <Text
                key={`tc-${tc.testCaseId}-${item.evaluatorId}-score-${sIdx}`}
                color={scoreColor(toNumericScore(s.data) ?? 0)}
              >
                {'      '}
                {scoreLabel}: {formatScorePart(s)}
              </Text>,
            );
          }
        } else {
          rows.push(
            <Text key={`tc-${tc.testCaseId}-${item.evaluatorId}-n/a`} color="gray">
              {'      '}
              n/a
            </Text>,
          );
        }
        if (!item.passed && item.logs && item.logs.length > 0) {
          for (let logIdx = 0; logIdx < item.logs.length; logIdx++) {
            const log = item.logs[logIdx];
            if (log.type === 'diff') {
              const lines = getDiffLines(log);
              for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const { type, line } = lines[lineIdx];
                rows.push(
                  <Text
                    key={`tc-${tc.testCaseId}-${item.evaluatorId}-${logIdx}-${lineIdx}`}
                    color={type === 'remove' ? 'red' : type === 'add' ? 'green' : 'gray'}
                  >
                    {'      '}
                    {line}
                  </Text>,
                );
              }
            } else if (log.type === 'log') {
              const logLines = getLogLines(log);
              for (let lineIdx = 0; lineIdx < logLines.length; lineIdx++) {
                rows.push(
                  <Text
                    key={`tc-${tc.testCaseId}-${item.evaluatorId}-${logIdx}-${lineIdx}`}
                    color="gray"
                  >
                    {'      '}
                    {logLines[lineIdx]}
                  </Text>,
                );
              }
            }
          }
        }
      }
    }
  }

  return rows;
}

export function RunDetailsView({
  state,
  dataset,
  selectedRun,
  evaluators,
}: RunDetailsViewProps): React.ReactNode {
  const runs = dataset?.runs ?? [];
  const rightFocused = state.focus === 'right';
  const [testCases, setTestCases] = useState<ParsedTestCaseProgress[]>([]);

  const evaluatorNameById = React.useMemo(
    () => new Map(evaluators.map((e) => [e.id, e.name])),
    [evaluators],
  );

  useEffect(() => {
    if (!selectedRun?.meta?.artifact) {
      setTestCases([]);
      return;
    }
    const artifactPath = resolve(selectedRun.meta.artifact);
    parseArtifactFile(artifactPath).then(setTestCases);
  }, [selectedRun?.meta?.artifact]);

  if (!selectedRun) {
    return (
      <>
        <RunsSidebar state={state} dataset={dataset} runs={runs} />
        <Pane flexGrow={1} marginLeft={1} focused={rightFocused}>
          <Text color="gray">Select a run to inspect details.</Text>
        </Pane>
      </>
    );
  }

  const rows = buildDetailRows(selectedRun, testCases, evaluatorNameById);
  const offset = Math.max(0, state.detailsScrollOffset);
  const visible = rows.slice(offset, offset + DETAILS_PAGE_SIZE);

  return (
    <>
      <RunsSidebar state={state} dataset={dataset} runs={runs} />
      <Pane flexGrow={1} marginLeft={1} focused={rightFocused}>
        <Box flexDirection="column">
          {visible.map((row, i) => (
            <React.Fragment key={i}>{row}</React.Fragment>
          ))}
        </Box>
      </Pane>
    </>
  );
}
