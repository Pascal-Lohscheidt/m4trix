import type { ReactNode } from 'react';
import {
  type CoverageReport,
  formatCoveragePercent,
  type GroupCoverage,
} from '../../lib/payload-mapper/coverage';
import { cx } from '../../lib/viewer';

export function coverageTone(score: number): string {
  if (score >= 0.9) return 'text-emerald-300';
  if (score >= 0.6) return 'text-amber-300';
  return 'text-red-300';
}

/** Stacked bar: mapped / partial / broken / unmatched. */
export function CoverageBar({
  report,
  className,
}: {
  report: CoverageReport | GroupCoverage;
  className?: string;
}): ReactNode {
  const total = Math.max(1, report.total);
  const seg = (n: number, color: string, label: string) =>
    n > 0 ? (
      <span className={color} style={{ width: `${(n / total) * 100}%` }} title={`${n} ${label}`} />
    ) : null;
  return (
    <span className={cx('flex h-1.5 overflow-hidden rounded-full bg-zinc-800', className)}>
      {seg(report.mapped, 'bg-emerald-400/80', 'mapped')}
      {seg(report.partial, 'bg-amber-400/80', 'partial')}
      {seg(report.fallback, 'bg-red-400/80', 'broken')}
      {seg(report.unmatched, 'bg-zinc-600', 'unmatched (raw)')}
    </span>
  );
}

export function coverageCounts(report: CoverageReport | GroupCoverage): string {
  return `${report.mapped} mapped · ${report.partial} partial · ${report.fallback} broken · ${report.unmatched} raw`;
}

export function CoverageSummary({
  after,
  before,
}: {
  after: CoverageReport;
  before?: CoverageReport;
}): ReactNode {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">
          Coverage on samples
        </span>
        {before && (
          <>
            <span className={cx('font-mono text-lg font-semibold', coverageTone(before.score))}>
              {formatCoveragePercent(before.score)}
            </span>
            <span className="text-zinc-500">→</span>
          </>
        )}
        <span className={cx('font-mono text-lg font-semibold', coverageTone(after.score))}>
          {formatCoveragePercent(after.score)}
        </span>
        <span className="ml-auto text-[11px] text-zinc-500">{coverageCounts(after)}</span>
      </div>
      <CoverageBar report={after} className="mt-2" />
    </div>
  );
}

/** Per-group status chip used in sample tables. */
export function GroupStatus({ group }: { group: GroupCoverage | undefined }): ReactNode {
  if (!group) return <span className="text-[10px] text-zinc-600">—</span>;
  const label =
    group.fallback > 0
      ? 'broken'
      : group.unmatched === group.total
        ? 'raw'
        : group.partial > 0 || group.unmatched > 0
          ? 'partial'
          : 'mapped';
  const tone =
    label === 'mapped'
      ? 'bg-emerald-500/15 text-emerald-300'
      : label === 'partial'
        ? 'bg-amber-500/15 text-amber-300'
        : label === 'broken'
          ? 'bg-red-500/15 text-red-300'
          : 'bg-zinc-800 text-zinc-400';
  return (
    <span
      className={cx('rounded px-1.5 py-0.5 text-[10px]', tone)}
      title={[coverageCounts(group), ...group.issues].join('\n')}
    >
      {label}
    </span>
  );
}
