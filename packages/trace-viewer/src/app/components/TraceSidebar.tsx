import { cx, getTraceEnv, statusTextClass } from '../lib/viewer';
import type { TraceFilters, TraceRow } from '../types';

type TraceSidebarProps = {
  traces: TraceRow[];
  allTraceCount: number;
  selectedTraceId: string | null;
  filters: TraceFilters;
  envOptions: string[];
  statusOptions: string[];
  projectOptions: string[];
  listErr: string | null;
  onFiltersChange: (filters: TraceFilters) => void;
  onSelectTrace: (traceId: string) => void;
};

const emptyFilters: TraceFilters = {
  env: '',
  status: '',
  projectId: '',
  query: '',
};

export function TraceSidebar(props: TraceSidebarProps): React.ReactNode {
  const {
    traces,
    allTraceCount,
    selectedTraceId,
    filters,
    envOptions,
    statusOptions,
    projectOptions,
    listErr,
    onFiltersChange,
    onSelectTrace,
  } = props;

  const setFilter = (key: keyof TraceFilters, value: string) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  return (
    <aside className="col-start-1 row-span-2 row-start-2 h-[calc(100vh-3rem)] min-w-0 overflow-auto border-r border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-zinc-50">Traces</div>
          <div className="mt-0.5 text-xs text-zinc-500">
            {traces.length} of {allTraceCount}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onFiltersChange(emptyFilters)}
          className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200"
        >
          Reset
        </button>
      </div>

      <div className="mb-3 space-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2">
        <input
          value={filters.query}
          onChange={(event) => setFilter('query', event.target.value)}
          placeholder="Search traces..."
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-400"
        />
        <div className="grid grid-cols-3 gap-2">
          <FilterSelect
            label="Env"
            value={filters.env}
            options={envOptions}
            onChange={(value) => setFilter('env', value)}
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            options={statusOptions}
            onChange={(value) => setFilter('status', value)}
          />
          <FilterSelect
            label="Project"
            value={filters.projectId}
            options={projectOptions}
            onChange={(value) => setFilter('projectId', value)}
          />
        </div>
      </div>

      {listErr && <div className="mb-3 text-[13px] text-red-400">{listErr}</div>}
      {!listErr && traces.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-800 p-3 text-sm text-zinc-500">
          No traces match these filters.
        </div>
      )}

      {traces.map((trace) => {
        const env = getTraceEnv(trace);
        const selected = selectedTraceId === trace.traceId;

        return (
          <button
            key={trace.traceId}
            type="button"
            onClick={() => onSelectTrace(trace.traceId)}
            className={cx(
              'mb-2 block w-full rounded-lg border px-3 py-2.5 text-left text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800',
              selected
                ? 'border-amber-400 bg-zinc-800 shadow-[0_0_0_1px_rgba(251,191,36,0.15)]'
                : 'border-zinc-700 bg-zinc-900',
            )}
          >
            <div className="truncate text-sm font-medium">{trace.name || trace.traceId}</div>
            <div className="mt-1 text-xs text-zinc-400">
              <span className={statusTextClass(trace.status)}>{trace.status}</span>
              {' · '}
              {trace.runCount} runs
              {env ? ` · ${env}` : ''}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-zinc-500">{trace.startTime}</div>
          </button>
        );
      })}
    </aside>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}): React.ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {props.label}
      </span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-400"
      >
        <option value="">All</option>
        {props.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
