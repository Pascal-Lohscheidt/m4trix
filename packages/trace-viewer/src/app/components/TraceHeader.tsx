import { type CoverageReport, formatCoveragePercent } from '../lib/payload-mapper/coverage';
import type { ProfileAggregates } from '../lib/trace-profiles/types';
import { useRef } from 'react';
import { useReveal } from '../lib/motion';
import { cx, formatTimestamp, getTraceEnv, statusDotClass, statusTextClass } from '../lib/viewer';
import { useMapperDialog } from '../state/mapper-dialog-context';
import { useViewerSettings } from '../state/viewer-settings-context';
import { CoverageBar, coverageCounts, coverageTone } from './mapper/CoverageSummary';
import { Segmented } from './ui/Segmented';
import type { TraceRow } from '../types';

type TraceHeaderProps = {
  trace: TraceRow;
  aggregates: ProfileAggregates;
  missingTracePayloadCount: number;
  tracePayloadBatchLoading: boolean;
  onLoadTracePayloads: () => void;
  /** When false (e.g. Raw profile), trace-wide payload CTA / aggregate strip is hidden. */
  showTracePayloadControls: boolean;
  /** Custom profile coverage over this trace's loaded payloads. */
  customCoverage?: { profileId: string; report: CoverageReport } | null;
};

export function TraceHeader({
  trace,
  aggregates,
  missingTracePayloadCount,
  tracePayloadBatchLoading,
  onLoadTracePayloads,
  showTracePayloadControls,
  customCoverage,
}: TraceHeaderProps): React.ReactNode {
  const { profileTabs, settings, setActiveProfileId, autoLoad } = useViewerSettings();
  const mapper = useMapperDialog();
  const activeProfileId = settings.activeTraceProfileId;
  const env = getTraceEnv(trace);
  const headerRef = useRef<HTMLElement>(null);
  useReveal(headerRef, trace.traceId, { distance: 12, staggerMs: 60 });
  const showAggregateRow =
    showTracePayloadControls &&
    (aggregates.pendingReason != null ||
      aggregates.cards.length > 0 ||
      missingTracePayloadCount > 0);

  return (
    <header ref={headerRef} className="shrink-0 px-2 pt-1">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div
            data-reveal
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-400"
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cx('h-1.5 w-1.5 rounded-full', statusDotClass(trace.status))}
              />
              <span className={statusTextClass(trace.status)}>{trace.status}</span>
            </span>
            <span aria-hidden="true" className="text-zinc-600">
              ·
            </span>
            <span className="tabular-nums">{trace.runCount} runs</span>
            {trace.projectId && (
              <>
                <span aria-hidden="true" className="text-zinc-600">
                  ·
                </span>
                <span>project {trace.projectId}</span>
              </>
            )}
            <span aria-hidden="true" className="text-zinc-600">
              ·
            </span>
            <span className="tabular-nums" title={trace.startTime}>
              {formatTimestamp(trace.startTime)}
            </span>
            {env && (
              <span className="ml-1 rounded-full bg-violet-400/10 px-2.5 py-0.5 text-xs text-violet-200 ring-1 ring-violet-300/20">
                {env}
              </span>
            )}
          </div>
          <h1
            data-reveal
            className="mt-1.5 truncate text-[clamp(1.6rem,2.6vw,2.4rem)] leading-tight font-semibold tracking-[-0.025em] text-zinc-50"
          >
            {trace.name || trace.traceId}
          </h1>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Segmented
            legend="Trace profile"
            value={activeProfileId}
            onChange={setActiveProfileId}
            items={profileTabs.map((tab) => ({
              key: tab.id,
              title: tab.kind === 'custom' ? 'Custom mapped profile' : undefined,
              label: (
                <>
                  {tab.kind === 'custom' && (
                    <span aria-hidden="true" className="text-violet-300">
                      ✦
                    </span>
                  )}
                  {tab.label}
                </>
              ),
            }))}
          />
          {mapper && (
            <div className="flex items-center gap-1.5">
              {customCoverage && customCoverage.report.total > 0 && (
                <span
                  className="glass-well flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] text-zinc-400"
                  title={[
                    `Coverage on ${customCoverage.report.total} loaded payloads: ${coverageCounts(customCoverage.report)}`,
                    ...customCoverage.report.groups
                      .filter((g) => g.mapped < g.total)
                      .slice(0, 8)
                      .map((g) => `• ${g.key}: ${coverageCounts(g)}`),
                  ].join('\n')}
                >
                  <span className={cx('font-mono', coverageTone(customCoverage.report.score))}>
                    {formatCoveragePercent(customCoverage.report.score)}
                  </span>
                  <CoverageBar report={customCoverage.report} className="w-12" />
                </span>
              )}
              {customCoverage && (
                <button
                  type="button"
                  onClick={() =>
                    mapper.openMapper({ mode: 'improve', profileId: customCoverage.profileId })
                  }
                  className="rounded-full bg-violet-400/15 px-3 py-1 text-xs text-violet-100 ring-1 ring-violet-300/25 transition-colors hover:bg-violet-400/25"
                >
                  ✦ Improve
                </button>
              )}
              <button
                type="button"
                onClick={() => mapper.openMapper({ mode: 'create' })}
                className="glass-chip rounded-full px-3 py-1 text-xs text-zinc-300 transition-colors hover:text-violet-100"
              >
                ✦ New AI profile
              </button>
            </div>
          )}
        </div>
      </div>

      {showAggregateRow && (
        <div className="mt-4 flex flex-wrap items-stretch gap-2">
          {aggregates.pendingReason === 'missing_trace_payloads' &&
            missingTracePayloadCount > 0 && (
              <div className="glass flex items-center gap-3 rounded-2xl px-4 py-2.5">
                <span className="text-xs text-zinc-400">
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
                    className="btn-primary rounded-full px-3.5 py-1.5 text-xs font-medium disabled:cursor-wait disabled:opacity-60"
                  >
                    {tracePayloadBatchLoading ? 'Loading…' : 'Load trace payloads'}
                  </button>
                )}
              </div>
            )}
          {aggregates.cards.map((card) => (
            <div key={card.id} data-reveal className="glass min-w-[7.5rem] rounded-2xl px-4 py-2.5">
              <div className="text-[11px] text-zinc-400">{card.label}</div>
              <div className="mt-0.5 font-mono text-lg leading-tight font-medium tracking-tight text-zinc-50 tabular-nums">
                {card.value}
              </div>
            </div>
          ))}
        </div>
      )}
    </header>
  );
}
