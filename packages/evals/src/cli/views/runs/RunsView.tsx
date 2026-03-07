/** @jsxImportSource react */
import React from 'react';
import { Box, Text } from 'ink';
import type { CliState, EvalDataset, EvalRun } from '../../types';
import { Pane, RunsSidebar, SectionHeader, Sparkline, StatusText, TextBar } from '../../components';

interface RunsViewProps {
  state: CliState;
  dataset: EvalDataset | undefined;
  selectedRun: EvalRun | undefined;
}

export function RunsView({
  state,
  dataset,
  selectedRun,
}: RunsViewProps): React.ReactNode {
  const runs = dataset?.runs ?? [];
  const rightFocused = state.focus === 'right';

  return (
    <>
      <RunsSidebar state={state} dataset={dataset} runs={runs} />
      <Pane flexGrow={1} marginLeft={1} focused={rightFocused}>
        {!selectedRun ? (
          <Text color="gray">Select a run to see summary metrics.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text color="gray">Run:</Text> {selectedRun.label}{' '}
              <StatusText status={selectedRun.status} />
            </Text>
            <Text color="gray">
              Commit: {selectedRun.meta.commit}  Branch: {selectedRun.meta.branch}{' '}
              Seed: {selectedRun.meta.seed}
            </Text>
            <Text> </Text>
            <SectionHeader>Overall</SectionHeader>
            <TextBar
              label="pass rate"
              value={selectedRun.performance.passRate}
              format={(v) => `${v}%`}
            />
            <TextBar
              label="avg score"
              value={Math.round(selectedRun.performance.avgScore * 100)}
            />
            <Text> </Text>
            <SectionHeader>Dimensions</SectionHeader>
            {selectedRun.dimensions.map((dimension) => (
              <TextBar
                key={dimension.name}
                label={dimension.name}
                value={dimension.score}
              />
            ))}
            <Text> </Text>
            <SectionHeader>Latency trend</SectionHeader>
            <Sparkline
              data={
                selectedRun.performance.latencyHistoryMs ?? [
                  selectedRun.performance.latencyAvgMs - 40,
                  selectedRun.performance.latencyAvgMs - 10,
                  selectedRun.performance.latencyAvgMs + 20,
                  selectedRun.performance.latencyP95Ms - 80,
                  selectedRun.performance.latencyP95Ms,
                ]
              }
              width={24}
            />
          </Box>
        )}
      </Pane>
    </>
  );
}
