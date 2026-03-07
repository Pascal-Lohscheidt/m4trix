import type { CliState, EvalsData, EvalDataset, EvalRun, StartupArgs } from './types';
import type {
  CollectedDataset,
  CollectedEvaluator,
  RunSnapshot,
  RunnerApi,
  RunnerEvent,
} from '../runner';

import mockData from './data.mock.json';

export function loadMockData(): EvalsData {
  return mockData as EvalsData;
}

function toSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function toEvalRun(snapshot: RunSnapshot): EvalRun {
  const total = snapshot.totalTestCases === 0 ? 1 : snapshot.totalTestCases;
  const passRate = Math.round((snapshot.passedTestCases / total) * 100);
  const avgScore = snapshot.passedTestCases / total;
  const durationMs = snapshot.finishedAt
    ? snapshot.finishedAt - (snapshot.startedAt ?? snapshot.queuedAt)
    : Date.now() - (snapshot.startedAt ?? snapshot.queuedAt);

  return {
    id: snapshot.runId,
    label: snapshot.runId.slice(0, 12),
    status:
      snapshot.status === 'completed'
        ? 'PASS'
        : snapshot.status === 'failed'
          ? 'FAILED'
          : 'RUNNING',
    performance: {
      passRate,
      avgScore,
      latencyP95Ms: Math.max(1, Math.floor(durationMs / Math.max(1, total))),
      latencyAvgMs: Math.max(1, Math.floor(durationMs / Math.max(1, total))),
      tokensAvg: 0,
      tokensP95: 0,
      costUsd: 0,
      latencyHistoryMs: [durationMs],
    },
    dimensions: [
      { name: 'passed', score: Math.round((snapshot.passedTestCases / total) * 100) },
      { name: 'failed', score: Math.round((snapshot.failedTestCases / total) * 100) },
    ],
    checks: [
      {
        name: 'run_status',
        passed: snapshot.status === 'completed',
        detail: snapshot.status,
      },
    ],
    failures:
      snapshot.errorMessage && snapshot.errorMessage.length > 0
        ? [{ title: snapshot.errorMessage }]
        : [],
    meta: {
      model: 'n/a',
      provider: 'runner',
      commit: 'local',
      branch: 'local',
      seed: 0,
      concurrency: 1,
      duration: `${durationMs}ms`,
      artifact: snapshot.artifactPath,
    },
  };
}

function toEvalDataset(
  item: CollectedDataset,
  snapshots: ReadonlyArray<RunSnapshot>,
): EvalDataset {
  const runs = snapshots
    .filter((snapshot) => snapshot.datasetId === item.id)
    .sort((a, b) => b.queuedAt - a.queuedAt)
    .map(toEvalRun);

  return {
    id: item.id,
    name: item.dataset.getName(),
    overview: `Discovered from ${item.filePath}`,
    runs,
  };
}

function toEvaluatorOption(item: CollectedEvaluator): EvalsData['evaluators'][number] {
  return {
    id: item.id,
    name: item.evaluator.getName() ?? toSlug(item.id),
    configPreview: `Source: ${item.filePath}`,
  };
}

export async function loadRunnerData(runner: RunnerApi): Promise<EvalsData> {
  const [datasets, evaluators, diskSnapshots] = await Promise.all([
    runner.collectDatasets(),
    runner.collectEvaluators(),
    runner.loadRunSnapshotsFromArtifacts(),
  ]);
  const memSnapshots = runner.getAllRunSnapshots();
  const seen = new Set(memSnapshots.map((s) => s.runId));
  const fromDisk = diskSnapshots.filter((s) => !seen.has(s.runId));
  const snapshots = [...memSnapshots, ...fromDisk].sort(
    (a, b) => b.queuedAt - a.queuedAt,
  );

  if (datasets.length === 0 && evaluators.length === 0) {
    return loadMockData();
  }

  return {
    datasets: datasets.map((dataset) => toEvalDataset(dataset, snapshots)),
    evaluators: evaluators.map(toEvaluatorOption),
  };
}

export function applyRunnerEvent(
  data: EvalsData,
  event: RunnerEvent,
  runner: RunnerApi,
): EvalsData {
  const snapshot = runner.getRunSnapshot(event.runId);
  if (!snapshot) {
    return data;
  }

  const dataset = data.datasets.find((item) => item.id === snapshot.datasetId);
  if (!dataset) {
    return data;
  }

  const run = toEvalRun(snapshot);
  const hasRun = dataset.runs.some((item) => item.id === run.id);
  const nextRuns = hasRun
    ? dataset.runs.map((item) => (item.id === run.id ? run : item))
    : [run, ...dataset.runs];

  return {
    ...data,
    datasets: data.datasets.map((item) =>
      item.id === dataset.id ? { ...item, runs: nextRuns } : item,
    ),
  };
}

export function parseStartupArgs(argv: string[]): StartupArgs {
  const args: StartupArgs = { unknownArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dataset' && argv[index + 1]) {
      args.datasetId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--run' && argv[index + 1]) {
      args.runId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--search' && argv[index + 1]) {
      args.search = argv[index + 1];
      index += 1;
      continue;
    }
    args.unknownArgs.push(token);
  }
  return args;
}

export function getFilteredDatasets(data: EvalsData, searchQuery: string): EvalDataset[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) {
    return data.datasets;
  }
  return data.datasets.filter((dataset) => dataset.name.toLowerCase().includes(query));
}

export function getDatasetByMenuIndex(datasets: EvalDataset[], menuIndex: number): EvalDataset | undefined {
  if (menuIndex <= 0) {
    return undefined;
  }
  return datasets[menuIndex - 1];
}

export function getRunByMenuIndex(dataset: EvalDataset | undefined, menuIndex: number): EvalRun | undefined {
  if (!dataset || menuIndex <= 0) {
    return undefined;
  }
  return dataset.runs[menuIndex - 1];
}

export function createInitialState(data: EvalsData, args: StartupArgs): CliState {
  const warnings: string[] = [];
  if (args.unknownArgs.length > 0) {
    warnings.push(`Unknown args: ${args.unknownArgs.join(', ')}`);
    warnings.push('Supported: --dataset <id>, --run <id>, --search <term>');
  }

  const searchQuery = args.search ?? '';
  const filteredDatasets = getFilteredDatasets(data, searchQuery);
  const datasetByArg = filteredDatasets.find((dataset) => dataset.id === args.datasetId);
  const datasetMenuIndex = datasetByArg ? filteredDatasets.indexOf(datasetByArg) + 1 : 0;

  let level: CliState['level'] = 'datasets';
  let runMenuIndex = 0;

  if (datasetByArg) {
    level = 'runs';
  } else if (args.datasetId) {
    warnings.push(`Dataset "${args.datasetId}" not found.`);
  }

  if (datasetByArg && args.runId) {
    const runIndex = datasetByArg.runs.findIndex((run) => run.id === args.runId);
    if (runIndex >= 0) {
      runMenuIndex = runIndex + 1;
      level = 'details';
    } else {
      warnings.push(`Run "${args.runId}" not found in dataset "${datasetByArg.id}".`);
    }
  }

  return {
    level,
    focus: 'left',
    datasetMenuIndex,
    runMenuIndex,
    detailsScrollOffset: 0,
    overviewScrollOffset: 0,
    selectedEvaluatorIds: data.evaluators.slice(0, 2).map((item) => item.id),
    evaluatorMenuIndex: 0,
    searchQuery,
    searchMode: false,
    startupWarnings: warnings,
  };
}

export type CliAction =
  | { type: 'MOVE_UP'; max: number }
  | { type: 'MOVE_DOWN'; max: number }
  | { type: 'ENTER'; hasDataset: boolean; hasRun: boolean }
  | { type: 'BACK' }
  | { type: 'TOGGLE_FOCUS' }
  | { type: 'START_SEARCH' }
  | { type: 'END_SEARCH' }
  | { type: 'APPEND_SEARCH'; value: string }
  | { type: 'REMOVE_SEARCH_CHAR' }
  | { type: 'TOGGLE_EVALUATOR'; evaluatorId: string }
  | { type: 'CLEAR_WARNINGS' };

export function reduceCliState(state: CliState, action: CliAction): CliState {
  if (action.type === 'MOVE_UP') {
    if (state.searchMode) {
      return state;
    }
    if (state.level === 'details' && state.focus === 'right') {
      return { ...state, detailsScrollOffset: Math.max(0, state.detailsScrollOffset - 1) };
    }
    if (state.level === 'datasets' && state.focus === 'right') {
      return { ...state, overviewScrollOffset: Math.max(0, state.overviewScrollOffset - 1) };
    }
    if (state.level === 'datasets') {
      return { ...state, datasetMenuIndex: Math.max(0, state.datasetMenuIndex - 1), overviewScrollOffset: 0 };
    }
    if (state.level === 'runs') {
      return { ...state, runMenuIndex: Math.max(0, state.runMenuIndex - 1) };
    }
    if (state.level === 'new-evaluation') {
      return { ...state, evaluatorMenuIndex: Math.max(0, state.evaluatorMenuIndex - 1) };
    }
    return state;
  }

  if (action.type === 'MOVE_DOWN') {
    if (state.searchMode) {
      return state;
    }
    if (state.level === 'details' && state.focus === 'right') {
      return { ...state, detailsScrollOffset: Math.min(action.max, state.detailsScrollOffset + 1) };
    }
    if (state.level === 'datasets' && state.focus === 'right') {
      return { ...state, overviewScrollOffset: Math.min(action.max, state.overviewScrollOffset + 1) };
    }
    if (state.level === 'datasets') {
      return { ...state, datasetMenuIndex: Math.min(action.max, state.datasetMenuIndex + 1), overviewScrollOffset: 0 };
    }
    if (state.level === 'runs') {
      return { ...state, runMenuIndex: Math.min(action.max, state.runMenuIndex + 1) };
    }
    if (state.level === 'new-evaluation') {
      return { ...state, evaluatorMenuIndex: Math.min(action.max, state.evaluatorMenuIndex + 1) };
    }
    return state;
  }

  if (action.type === 'ENTER') {
    if (state.searchMode) {
      return { ...state, searchMode: false };
    }
    if (state.level === 'datasets') {
      if (state.datasetMenuIndex === 0) {
        return { ...state, level: 'new-evaluation' };
      }
      if (action.hasDataset) {
        return { ...state, level: 'runs', runMenuIndex: 0 };
      }
      return state;
    }
    if (state.level === 'runs') {
      if (state.runMenuIndex === 0) {
        return { ...state, level: 'new-evaluation' };
      }
      if (action.hasRun) {
        return { ...state, level: 'details', detailsScrollOffset: 0 };
      }
      return state;
    }
    if (state.level === 'new-evaluation') {
      return state;
    }
    return state;
  }

  if (action.type === 'BACK') {
    if (state.searchMode) {
      return { ...state, searchMode: false };
    }
    if (state.level === 'details') {
      return { ...state, level: 'runs' };
    }
    if (state.level === 'runs' || state.level === 'new-evaluation') {
      return { ...state, level: 'datasets' };
    }
    return state;
  }

  if (action.type === 'TOGGLE_FOCUS') {
    return { ...state, focus: state.focus === 'left' ? 'right' : 'left' };
  }

  if (action.type === 'START_SEARCH') {
    return { ...state, searchMode: true };
  }

  if (action.type === 'END_SEARCH') {
    return { ...state, searchMode: false };
  }

  if (action.type === 'APPEND_SEARCH') {
    return { ...state, searchQuery: `${state.searchQuery}${action.value}` };
  }

  if (action.type === 'REMOVE_SEARCH_CHAR') {
    return { ...state, searchQuery: state.searchQuery.slice(0, -1) };
  }

  if (action.type === 'TOGGLE_EVALUATOR') {
    const exists = state.selectedEvaluatorIds.includes(action.evaluatorId);
    return {
      ...state,
      selectedEvaluatorIds: exists
        ? state.selectedEvaluatorIds.filter((id) => id !== action.evaluatorId)
        : [...state.selectedEvaluatorIds, action.evaluatorId],
    };
  }

  if (action.type === 'CLEAR_WARNINGS') {
    return { ...state, startupWarnings: [] };
  }

  return state;
}
