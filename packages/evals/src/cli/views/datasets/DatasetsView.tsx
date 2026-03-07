/** @jsxImportSource react */
import React, { useEffect, useMemo, useState } from 'react';
import { resolve } from 'node:path';
import { Box, Text } from 'ink';
import { LineGraph } from '@pppp606/ink-chart';
import {
  parseArtifactFile,
  type ParsedTestCaseProgress,
} from '../../../runner';
import { toNumericScoreFromScores } from '../../../runner/score-utils';
import type { CliState, EvalDataset, EvalRun } from '../../types';
import { ListItem, Pane, SectionHeader, TextBar } from '../../components';

const LEFT_PANE_WIDTH = 44;
const MAX_RUNS_FOR_CHART = 12;
const MAX_RUNS_FOR_TREND = 20;
const TREND_BATCH_SIZE = 4;

interface RunScore {
  runId: string;
  label: string;
  value: number;
}

function extractRunAverageScore(
  testCases: ParsedTestCaseProgress[],
): number | undefined {
  const scores: number[] = [];
  for (const tc of testCases) {
    for (const es of tc.evaluatorScores) {
      const n = toNumericScoreFromScores(es.scores);
      if (n !== undefined) {
        scores.push(n);
      }
    }
  }
  if (scores.length === 0) return undefined;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

async function loadRunScores(runs: EvalRun[]): Promise<RunScore[]> {
  const results: RunScore[] = [];
  for (const run of runs) {
    const artifact = run.meta?.artifact;
    if (!artifact) continue;
    try {
      const path = resolve(artifact);
      const testCases = await parseArtifactFile(path);
      const avg = extractRunAverageScore(testCases);
      if (avg !== undefined) {
        results.push({
          runId: run.id,
          label: run.label,
          value: avg,
        });
      }
    } catch {
      // Skip runs with unreadable artifacts
    }
  }
  return results;
}

function batchAverage(values: number[], batchSize: number): number[] {
  const batches: number[] = [];
  for (let i = 0; i < values.length; i += batchSize) {
    const slice = values.slice(i, i + batchSize);
    if (slice.length > 0) {
      batches.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
  }
  return batches;
}

export const OVERVIEW_PAGE_SIZE = 15;

interface DatasetsViewProps {
  state: CliState;
  filteredDatasets: EvalDataset[];
  selectedDataset: EvalDataset | undefined;
  /** Ref updated with overview row count for scroll max */
  overviewRowCountRef?: React.MutableRefObject<number>;
}

export function DatasetsView({
  state,
  filteredDatasets,
  selectedDataset,
  overviewRowCountRef,
}: DatasetsViewProps): React.ReactNode {
  const leftFocused = state.focus === 'left';
  const rightFocused = state.focus === 'right';
  const [runScores, setRunScores] = useState<RunScore[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedDataset?.runs?.length) {
      setRunScores([]);
      return;
    }
    setLoading(true);
    const runs = selectedDataset.runs.slice(0, MAX_RUNS_FOR_TREND);
    loadRunScores(runs)
      .then(setRunScores)
      .finally(() => setLoading(false));
  }, [selectedDataset?.id, selectedDataset?.runs?.length]);

  const barData = runScores.slice(0, MAX_RUNS_FOR_CHART).reverse();
  const trendValues = runScores
    .slice(0, MAX_RUNS_FOR_TREND)
    .map((r: RunScore) => r.value)
    .reverse();
  const trendBatched = batchAverage(trendValues, TREND_BATCH_SIZE);

  const overviewRows = useMemo((): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    rows.push(
      <Text key="overview" color="gray">
        {selectedDataset?.overview ?? 'Select a dataset to inspect prior runs.'}
      </Text>,
    );
    if (selectedDataset && selectedDataset.runs.length > 0) {
      if (loading) {
        rows.push(
          <Text key="loading" color="gray">
            Loading run scores…
          </Text>,
        );
      } else if (runScores.length > 0) {
        rows.push(
          <Text key="scores-header" color="gray">
            Scores (last runs)
          </Text>,
        );
        for (const d of barData) {
          rows.push(
            <TextBar
              key={d.runId}
              label={d.label}
              value={d.value}
              labelWidth={14}
              barWidth={24}
              max={100}
              format={(v) => v.toFixed(1)}
            />,
          );
        }
        if (trendBatched.length > 0) {
          rows.push(
            <Text key="trend-header" color="gray">
              Avg trend (last 20, batched by 4)
            </Text>,
          );
          rows.push(
            <Box key="trend-graph">
              <LineGraph
                data={[{ values: trendBatched, color: 'cyan' }]}
                height={5}
                width={45}
                showYAxis={true}
                xLabels={['older', 'newer']}
              />
            </Box>,
          );
        }
      }
    }
    return rows;
  }, [
    selectedDataset?.overview,
    selectedDataset?.runs?.length,
    loading,
    runScores,
    barData,
    trendBatched,
  ]);

  if (overviewRowCountRef) {
    overviewRowCountRef.current = overviewRows.length;
  }

  const offset = Math.max(0, state.overviewScrollOffset);
  const visibleRows = overviewRows.slice(offset, offset + OVERVIEW_PAGE_SIZE);

  return (
    <>
      <Pane width={LEFT_PANE_WIDTH} focused={leftFocused}>
        <SectionHeader>Datasets</SectionHeader>
        <ListItem
          selected={state.datasetMenuIndex === 0}
          label="New evaluation"
          itemKey="datasets-new-eval"
        />
        {filteredDatasets.map((dataset, index) => (
          <ListItem
            key={dataset.id}
            selected={state.datasetMenuIndex === index + 1}
            label={dataset.name}
            itemKey={`dataset-${dataset.id}`}
          />
        ))}
      </Pane>
      <Pane flexGrow={1} marginLeft={1} focused={rightFocused}>
        <SectionHeader>Overview</SectionHeader>
        <Box flexDirection="column">
          {visibleRows.map((row, i) => (
            <Box key={offset + i}>{row}</Box>
          ))}
        </Box>
      </Pane>
    </>
  );
}
