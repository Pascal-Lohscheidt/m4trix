export type EvalStatus = 'PASS' | 'FAILED' | 'RUNNING';

export interface EvalDimension {
  name: string;
  score: number;
}

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface EvalFailure {
  title: string;
}

export interface EvalPerformance {
  passRate: number;
  avgScore: number;
  latencyP95Ms: number;
  latencyAvgMs: number;
  tokensAvg: number;
  tokensP95: number;
  costUsd: number;
  /** Per-sample latency in ms for sparkline (e.g. last N requests) */
  latencyHistoryMs?: number[];
}

export interface EvalRunMeta {
  model: string;
  provider: string;
  commit: string;
  branch: string;
  seed: number;
  concurrency: number;
  duration: string;
  artifact: string;
}

export interface EvalRun {
  id: string;
  label: string;
  status: EvalStatus;
  performance: EvalPerformance;
  dimensions: EvalDimension[];
  checks: EvalCheck[];
  failures: EvalFailure[];
  meta: EvalRunMeta;
}

export interface EvalDataset {
  id: string;
  name: string;
  overview: string;
  runs: EvalRun[];
}

export interface EvaluatorOption {
  id: string;
  name: string;
  configPreview: string;
}

export interface EvalsData {
  datasets: EvalDataset[];
  evaluators: EvaluatorOption[];
}

export type PaneFocus = 'left' | 'right';

export type ViewLevel = 'datasets' | 'runs' | 'details' | 'new-evaluation';

export interface StartupArgs {
  datasetId?: string;
  runId?: string;
  search?: string;
  unknownArgs: string[];
}

export interface CliState {
  level: ViewLevel;
  focus: PaneFocus;
  datasetMenuIndex: number;
  runMenuIndex: number;
  detailsScrollOffset: number;
  overviewScrollOffset: number;
  selectedEvaluatorIds: string[];
  evaluatorMenuIndex: number;
  searchQuery: string;
  searchMode: boolean;
  startupWarnings: string[];
}
