import type { ProfileAggregates } from '../lib/trace-profiles/types';
import { cx, getTraceEnv, statusTextClass } from '../lib/viewer';
import { useViewerSettings } from '../state/viewer-settings-context';
import type { TraceRow } from '../types';

type TraceHeaderProps = {
  trace: TraceRow;
  aggregates: ProfileAggregates;
  missingTracePayloadCount: number;
  tracePayloadBatchLoading: boolean;
  onLoadTracePayloads: () => void;
  /** When false (e.g. Raw profile), trace-wide payload CTA / aggregate strip is hidden. */
  showTracePayloadControls: boolean;
};

export function TraceHeader({
  trace,
  aggregates,
  missingTracePayloadCount,
  tracePayloadBatchLoading,
  onLoadTracePayloads,
  showTracePayloadControls,
}: TraceHeaderProps): React.ReactNode {
  const { profileTabs, settings, setActiveProfileId, autoLoad } = useViewerSettings();
  const activeProfileId = settings.activeTraceProfileId;
  const env = getTraceEnv(trace);
  const showAggregateRow =
    showTracePayloadControls &&
    (aggregates.pendingReason != null ||
      aggregates.cards.length > 0 ||
      missingTracePayloadCount > 0);

  return (
    <header className="min-h-20 border-b border-zinc-800 bg-zinc-950 px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold text-zinc-50">{trace.name}</div>
          <div className="mt-1.5 text-[13px] text-zinc-400">
            <span className={statusTextClass(trace.status)}>{trace.status}</span>
            {' · '}
            {trace.runCount} runs
            {trace.projectId ? ` · project ${trace.projectId}` : ''}
            {' · '}
            {trace.startTime}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {env && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300">
              {env}
            </span>
          )}
          <fieldset className="m-0 flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
            <legend className="sr-only">Trace profile</legend>
            {profileTabs.map((tab) => {
              const selected = tab.id === activeProfileId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveProfileId(tab.id)}
                  className={cx(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    selected
                      ? 'bg-amber-500/20 text-amber-200'
                      : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </fieldset>
        </div>
      </div>

      {showAggregateRow && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-3">
          {aggregates.pendingReason === 'missing_trace_payloads' &&
            missingTracePayloadCount > 0 && (
              <>
                <span className="text-xs text-zinc-500">
                  {autoLoad && tracePayloadBatchLoading
                    ? 'Loading trace payloads for aggregates…'
                    : autoLoad
                      ? 'Waiting for trace payloads…'
                      : `Aggregates need ${missingTracePayloadCount} payload${missingTracePayloadCount === 1 ? '' : 's'} from this trace.`}
                </span>
                {!autoLoad && (
                  <button
                    type="button"
                    disabled={tracePayloadBatchLoading}
                    onClick={onLoadTracePayloads}
                    className="rounded-md border border-violet-500/40 bg-violet-500/15 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-500/25 disabled:cursor-wait disabled:opacity-60"
                  >
                    {tracePayloadBatchLoading ? 'Loading…' : 'Load trace payloads'}
                  </button>
                )}
              </>
            )}
          {aggregates.cards.map((card) => (
            <div
              key={card.id}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300"
            >
              <span className="text-zinc-500">{card.label}: </span>
              <span className="font-mono text-zinc-100">{card.value}</span>
            </div>
          ))}
        </div>
      )}
    </header>
  );
}
