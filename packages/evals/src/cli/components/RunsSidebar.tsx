/** @jsxImportSource react */
import type React from 'react';
import { Text } from 'ink';
import type { CliState, EvalDataset, EvalRun } from '../types.js';
import { ListItem } from './ListItem.js';
import { Pane } from './Pane.js';
import { SectionHeader } from './SectionHeader.js';
import { StatusText } from './StatusText.js';

const LEFT_PANE_WIDTH = 44;

interface RunsSidebarProps {
  state: CliState;
  dataset: EvalDataset | undefined;
  runs: EvalRun[];
}

export function RunsSidebar({ state, runs }: RunsSidebarProps): React.ReactNode {
  const focused = state.focus === 'left';
  return (
    <Pane width={LEFT_PANE_WIDTH} focused={focused}>
      <SectionHeader>Runs</SectionHeader>
      <ListItem
        selected={state.runMenuIndex === 0}
        label="New evaluation"
        itemKey="runs-new-eval"
      />
      {runs.map((run, index) => (
        <Text
          key={run.id}
          color={state.runMenuIndex === index + 1 ? 'cyan' : 'gray'}
          bold={state.runMenuIndex === index + 1}
        >
          {state.runMenuIndex === index + 1 ? '▸ ' : '  '}
          {run.label} <StatusText status={run.status} />
        </Text>
      ))}
    </Pane>
  );
}
