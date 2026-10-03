import { CaretDownIcon } from '@phosphor-icons/react';
import { useRef } from 'react';
import { useReveal } from '../lib/motion';
import { cx, formatTimestamp, getTraceEnv, statusDotClass } from '../lib/viewer';
import { AUTO_UPDATE_PRESETS } from '../lib/viewer-settings';
import { useViewerSettings } from '../state/viewer-settings-context';
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

/** Only the first screenful staggers in; long lists should not take seconds to appear. */
const REVEAL_LIMIT = 18;

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
  const { settings } = useViewerSettings();
  const listRef = useRef<HTMLDivElement>(null);
  const hasTraces = traces.length > 0;
  useReveal(listRef, hasTraces, { distance: 8, staggerMs: 28 });

  const setFilter = (key: keyof TraceFilters, value: string) => {
    onFiltersChange({ ...filters, [key]: value });
  };
  const filtersActive = Object.values(filters).some(Boolean);
  const autoUpdateLabel = AUTO_UPDATE_PRESETS.find(
    (preset) => preset.value === settings.autoUpdatePreset,
  )?.label;
  const live = settings.autoUpdatePreset !== 'off';

  return (
    <aside className="glass flex h-full w-[300px] shrink-0 flex-col overflow-clip rounded-[28px]">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 via-violet-500 to-indigo-600 text-[15px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.4),0_6px_16px_-6px_rgb(124_58_237_/_0.8)]">
          m
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-semibold tracking-tight text-zinc-50">m4trix</div>
          <div className="text-xs text-zinc-500">Trace viewer</div>
        </div>
      </div>

      <div className="px-3">
        <div className="mb-2 flex items-baseline justify-between px-2">
          <span className="text-xs font-medium text-zinc-400">Filters</span>
          {filtersActive && (
            <button
              type="button"
              onClick={() => onFiltersChange(emptyFilters)}
              className="text-xs text-violet-300 transition-colors hover:text-violet-200"
            >
              Reset
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1.5">
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

      <div className="mt-5 mb-1.5 flex items-baseline justify-between px-5">
        <span className="text-xs font-medium text-zinc-400">Traces</span>
        <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
          {traces.length}/{allTraceCount}
        </span>
      </div>

      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {listErr && (
          <div className="mx-2 rounded-2xl bg-rose-500/10 p-3 text-[13px] text-rose-300">
            {listErr}
          </div>
        )}
        {!listErr && traces.length === 0 && (
          <div className="mx-2 rounded-2xl border border-dashed border-white/10 p-4 text-sm text-zinc-500">
            No traces match these filters.
          </div>
        )}

        {traces.map((trace, index) => {
          const env = getTraceEnv(trace);
          const selected = selectedTraceId === trace.traceId;

          return (
            <button
              key={trace.traceId}
              type="button"
              data-reveal={index < REVEAL_LIMIT ? '' : undefined}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelectTrace(trace.traceId)}
              className={cx(
                'group mb-0.5 flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-left transition-[background-color,box-shadow] duration-200',
                selected
                  ? 'bg-violet-400/[0.14] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08),inset_0_0_0_1px_rgb(196_181_253_/_0.14)]'
                  : 'hover:bg-white/[0.05]',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full',
                  statusDotClass(trace.status),
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cx(
                    'block truncate text-sm font-medium',
                    selected ? 'text-violet-50' : 'text-zinc-200 group-hover:text-zinc-50',
                  )}
                >
                  {trace.name || trace.traceId}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                  <span className="sr-only">{trace.status},</span>
                  <span className="tabular-nums">{trace.runCount} runs</span>
                  {env && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{env}</span>
                    </>
                  )}
                </span>
                <span
                  className="mt-0.5 block truncate text-[11px] text-zinc-600 tabular-nums"
                  title={trace.startTime}
                >
                  {formatTimestamp(trace.startTime)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2.5 border-t border-white/[0.06] px-5 py-3.5 text-xs text-zinc-500">
        <span
          aria-hidden="true"
          className={cx('h-2 w-2 rounded-full', live ? 'live-dot bg-emerald-400' : 'bg-zinc-600')}
        />
        {live ? `Auto-updating every ${autoUpdateLabel}` : 'Auto-update off'}
      </div>
    </aside>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}): React.ReactNode {
  const active = props.value !== '';
  return (
    <label
      className={cx(
        'relative block rounded-xl px-2.5 pt-1.5 pb-1 transition-colors',
        active ? 'bg-violet-400/[0.12] ring-1 ring-violet-300/20' : 'glass-well',
      )}
    >
      <span className="block text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
        {props.label}
      </span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className={cx(
          'w-full cursor-pointer appearance-none truncate bg-transparent pr-4 text-xs outline-none',
          active ? 'text-violet-100' : 'text-zinc-200',
        )}
      >
        <option value="">All</option>
        {props.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <CaretDownIcon
        aria-hidden="true"
        weight="bold"
        className="pointer-events-none absolute right-2 bottom-2 h-3 w-3 text-zinc-500"
      />
    </label>
  );
}
