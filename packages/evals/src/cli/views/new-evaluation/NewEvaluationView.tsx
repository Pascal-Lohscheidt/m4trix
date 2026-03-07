/** @jsxImportSource react */
import React from 'react';
import { Text } from 'ink';
import type { CliState, EvalsData } from '../../types';
import { Pane, SectionHeader } from '../../components';

const LEFT_PANE_WIDTH = 44;

interface NewEvaluationViewProps {
  state: CliState;
  data: EvalsData;
  visibleEvaluators: EvalsData['evaluators'];
}

export function NewEvaluationView({
  state,
  data,
  visibleEvaluators,
}: NewEvaluationViewProps): React.ReactNode {
  const selectedCount = state.selectedEvaluatorIds.length;
  const focusedEvaluator = visibleEvaluators[state.evaluatorMenuIndex];
  const leftFocused = state.focus === 'left';
  const rightFocused = state.focus === 'right';

  return (
    <>
      <Pane width={LEFT_PANE_WIDTH} focused={leftFocused}>
        <SectionHeader>Available Evaluators</SectionHeader>
        <Text color="gray">Search: {state.searchQuery || '(none)'}</Text>
        {visibleEvaluators.map((evaluator, index) => {
          const selected = index === state.evaluatorMenuIndex;
          const inSelection = state.selectedEvaluatorIds.includes(evaluator.id);
          return (
            <Text
              key={evaluator.id}
              color={selected ? 'cyan' : 'gray'}
              bold={selected}
            >
              {selected ? '▸ ' : '  '}
              {inSelection ? '[x] ' : '[ ] '}
              {evaluator.name}
            </Text>
          );
        })}
      </Pane>
      <Pane flexGrow={1} marginLeft={1} focused={rightFocused}>
        <SectionHeader>Selected ({selectedCount})</SectionHeader>
        {state.selectedEvaluatorIds.map((id, index) => {
          const evaluator = data.evaluators.find((item) => item.id === id);
          if (!evaluator) return null;
          return (
            <Text key={id}>
              {index + 1}) {evaluator.name}
            </Text>
          );
        })}
        <SectionHeader>Config preview</SectionHeader>
        <Text color="gray">
          {focusedEvaluator?.configPreview ??
            'Select an evaluator to inspect config.'}
        </Text>
      </Pane>
    </>
  );
}
