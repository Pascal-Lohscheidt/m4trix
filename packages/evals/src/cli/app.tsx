/** @jsxImportSource react */
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { useScreenSize } from 'fullscreen-ink';

import { getBreadcrumbText, getFooterText } from './components';
import {
  isBackKey,
  isPrintableCharacter,
  isQuitInput,
  isSearchInput,
} from './keys';
import {
  createInitialState,
  applyRunnerEvent,
  getDatasetByMenuIndex,
  getFilteredDatasets,
  getRunByMenuIndex,
  reduceCliState,
} from './state';
import type { CliState, EvalsData, StartupArgs } from './types';
import type { RunnerApi } from '../runner';
import {
  DatasetsView,
  NewEvaluationView,
  OVERVIEW_PAGE_SIZE,
  RunDetailsView,
  RunsView,
} from './views';

interface EvalsCliAppProps {
  data: EvalsData;
  args: StartupArgs;
  runner?: RunnerApi;
}

function clampCursor(
  state: CliState,
  filteredDatasetsLength: number,
  selectedRunCount: number,
): CliState {
  const datasetMax = filteredDatasetsLength;
  const runMax = selectedRunCount;
  const evaluatorMax = 3;
  return {
    ...state,
    datasetMenuIndex: Math.max(0, Math.min(state.datasetMenuIndex, datasetMax)),
    runMenuIndex: Math.max(0, Math.min(state.runMenuIndex, runMax)),
    evaluatorMenuIndex: Math.max(
      0,
      Math.min(state.evaluatorMenuIndex, evaluatorMax),
    ),
  };
}

export function EvalsCliApp({
  data,
  args,
  runner,
}: EvalsCliAppProps): React.ReactNode {
  const { exit } = useApp();
  const { width: stdoutWidth, height: stdoutHeight } = useScreenSize();
  const [liveData, setLiveData] = useState<EvalsData>(data);
  const [runtimeMessage, setRuntimeMessage] = useState<string | undefined>();
  const overviewRowCountRef = useRef(0);
  const [state, dispatch] = useReducer(
    reduceCliState,
    createInitialState(data, args),
  );

  useEffect(() => {
    setLiveData(data);
  }, [data]);

  useEffect(() => {
    if (!runner) {
      return undefined;
    }
    return runner.subscribeRunEvents((event) => {
      setLiveData((current) => applyRunnerEvent(current, event, runner));
      if (event.type === 'RunQueued') {
        setRuntimeMessage(`Queued ${event.runId} with ${event.totalTestCases} test cases.`);
      }
      if (event.type === 'RunCompleted') {
        setRuntimeMessage(
          `Completed ${event.runId}: ${event.passedTestCases}/${event.totalTestCases} passed.`,
        );
      }
      if (event.type === 'RunFailed') {
        setRuntimeMessage(`Run failed: ${event.errorMessage}`);
      }
    });
  }, [runner]);

  const filteredDatasets = useMemo(
    () => getFilteredDatasets(liveData, state.searchQuery),
    [liveData, state.searchQuery],
  );
  const clampedState = clampCursor(
    state,
    filteredDatasets.length,
    getDatasetByMenuIndex(filteredDatasets, state.datasetMenuIndex)?.runs
      .length ?? 0,
  );
  const selectedDataset = getDatasetByMenuIndex(
    filteredDatasets,
    clampedState.datasetMenuIndex,
  );
  const selectedRun = getRunByMenuIndex(
    selectedDataset,
    clampedState.runMenuIndex,
  );
  const visibleEvaluators = liveData.evaluators.filter((evaluator) =>
    evaluator.name
      .toLowerCase()
      .includes(clampedState.searchQuery.toLowerCase()),
  );

  useInput((input, key) => {
    if (isQuitInput(input) || key.escape) {
      exit();
      return;
    }

    if (key.tab) {
      dispatch({ type: 'TOGGLE_FOCUS' });
      return;
    }

    if (isSearchInput(input)) {
      dispatch({ type: 'START_SEARCH' });
      return;
    }

    if (clampedState.searchMode) {
      if (key.return) {
        dispatch({ type: 'END_SEARCH' });
        return;
      }
      if (isBackKey(key)) {
        dispatch({ type: 'REMOVE_SEARCH_CHAR' });
        return;
      }
      if (isPrintableCharacter(input)) {
        dispatch({ type: 'APPEND_SEARCH', value: input });
      }
      return;
    }

    if (key.upArrow) {
      const max =
        clampedState.level === 'details'
          ? 100
          : clampedState.level === 'new-evaluation'
            ? visibleEvaluators.length - 1
            : 100;
      dispatch({ type: 'MOVE_UP', max });
      return;
    }

    if (key.downArrow) {
      let max: number;
      if (clampedState.level === 'datasets') {
        max =
          clampedState.focus === 'right'
            ? Math.max(0, overviewRowCountRef.current - OVERVIEW_PAGE_SIZE)
            : filteredDatasets.length;
      } else if (clampedState.level === 'runs') {
        max = selectedDataset?.runs.length ?? 0;
      } else if (clampedState.level === 'new-evaluation') {
        max = Math.max(0, visibleEvaluators.length - 1);
      } else {
        max = 100;
      }
      dispatch({ type: 'MOVE_DOWN', max });
      return;
    }

    if (key.return) {
      dispatch({
        type: 'ENTER',
        hasDataset: Boolean(selectedDataset),
        hasRun: Boolean(selectedRun),
      });
      if (clampedState.level === 'new-evaluation') {
        const evaluator = visibleEvaluators[clampedState.evaluatorMenuIndex];
        if (evaluator) {
          dispatch({ type: 'TOGGLE_EVALUATOR', evaluatorId: evaluator.id });
        }
      }
      return;
    }

    if (isBackKey(key) || input === '\x7f' || input === '\b') {
      dispatch({ type: 'BACK' });
      return;
    }

    if (input.toLowerCase() === 'c') {
      dispatch({ type: 'CLEAR_WARNINGS' });
      setRuntimeMessage(undefined);
      return;
    }

    if (input.toLowerCase() === 's' && clampedState.level === 'new-evaluation') {
      if (!runner) {
        setRuntimeMessage('Runner unavailable: cannot start evaluation.');
        return;
      }
      if (!selectedDataset) {
        setRuntimeMessage('Select a dataset before starting a new evaluation.');
        return;
      }
      if (clampedState.selectedEvaluatorIds.length === 0) {
        setRuntimeMessage('Select at least one evaluator before starting.');
        return;
      }

      void runner
        .runDatasetWith({
          datasetId: selectedDataset.id,
          evaluatorIds: clampedState.selectedEvaluatorIds,
        })
        .then((snapshot) => {
          setRuntimeMessage(
            `Started ${snapshot.runId} on ${selectedDataset.name} (${snapshot.totalTestCases} cases).`,
          );
        })
        .catch((error) => {
          setRuntimeMessage(
            error instanceof Error ? error.message : 'Failed to start evaluation.',
          );
        });
    }
  });

  const renderContent = () => {
    if (clampedState.level === 'new-evaluation') {
      return (
        <NewEvaluationView
          state={clampedState}
          data={liveData}
          visibleEvaluators={visibleEvaluators}
        />
      );
    }
    if (clampedState.level === 'datasets') {
      return (
        <DatasetsView
          state={clampedState}
          filteredDatasets={filteredDatasets}
          selectedDataset={selectedDataset}
          overviewRowCountRef={overviewRowCountRef}
        />
      );
    }
    if (clampedState.level === 'runs') {
      return (
        <RunsView
          state={clampedState}
          dataset={selectedDataset}
          selectedRun={selectedRun}
        />
      );
    }
    return (
      <RunDetailsView
        state={clampedState}
        dataset={selectedDataset}
        selectedRun={selectedRun}
        evaluators={liveData.evaluators}
      />
    );
  };

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      width={stdoutWidth}
      height={stdoutHeight}
    >
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        width={stdoutWidth}
      >
        <Text>
          {getBreadcrumbText(
            clampedState,
            selectedDataset?.name,
            selectedRun?.label,
          )}
        </Text>
      </Box>

      {clampedState.startupWarnings.length > 0 && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          flexDirection="column"
          width={stdoutWidth}
        >
          <Text color="yellow">Startup warnings:</Text>
          {clampedState.startupWarnings.map((warning, index) => (
            <Text key={`${warning}-${index}`}>{warning}</Text>
          ))}
        </Box>
      )}

      {clampedState.searchMode && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="magenta"
          paddingX={1}
          width={stdoutWidth}
        >
          <Text color="magenta" bold>Search: </Text>
          <Text color="white">{clampedState.searchQuery}</Text>
        </Box>
      )}

      {runtimeMessage && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="blue"
          paddingX={1}
          width={stdoutWidth}
        >
          <Text color="blue">{runtimeMessage}</Text>
        </Box>
      )}

      <Box
        marginTop={1}
        flexGrow={1}
        width={stdoutWidth}
        flexDirection="row"
      >
        {renderContent()}
      </Box>

      <Box marginTop={1} paddingX={1}>
        <Text color="gray">{getFooterText(clampedState)}</Text>
      </Box>
    </Box>
  );
}
