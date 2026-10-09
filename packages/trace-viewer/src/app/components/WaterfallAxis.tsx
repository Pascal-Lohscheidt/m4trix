import type { ReactNode } from 'react';
import { cx, formatLatency } from '../lib/viewer';
import type { TraceTimeline } from '../lib/waterfall';
import { WATERFALL_COLUMN_CLASS, WATERFALL_LABEL_CLASS, WATERFALL_TRACK_CLASS } from './RunTree';

/** Sub-10 ms spans get fractional ticks; `formatLatency` would round them all to the same label. */
function formatTick(ms: number): string {
  if (ms > 0 && ms < 10 && !Number.isInteger(ms)) return `${ms} ms`;
  return formatLatency(ms);
}

/**
 * Sticky time ruler above the waterfall. Its right edge mirrors a run row (button padding, column
 * and duration slot), so ticks sit exactly over the bars.
 */
export function WaterfallAxis({
  timeline,
  ticks,
}: {
  timeline: TraceTimeline;
  ticks: number[];
}): ReactNode {
  return (
    <div className="sticky top-0 z-10 -mx-1 mb-1 flex justify-end rounded-xl bg-zinc-950/55 px-1 py-1.5 pr-3.5 backdrop-blur-md">
      <div className={cx('ml-3 flex items-center gap-2', WATERFALL_COLUMN_CLASS)}>
        <div className={cx(WATERFALL_TRACK_CLASS, 'h-4 bg-none')}>
          {ticks.map((tick) => {
            const pct = timeline.spanMs > 0 ? (tick / timeline.spanMs) * 100 : 0;
            return (
              <span
                key={tick}
                className={cx(
                  'absolute top-0 font-mono text-[10px] whitespace-nowrap text-zinc-500 tabular-nums',
                  pct === 0 ? 'translate-x-0' : pct > 90 ? '-translate-x-full' : '-translate-x-1/2',
                )}
                style={{ left: `${pct}%` }}
              >
                {formatTick(tick)}
              </span>
            );
          })}
        </div>
        <span
          className={cx(WATERFALL_LABEL_CLASS, 'font-mono text-[10px] text-zinc-400 tabular-nums')}
          title="Trace span: first run start to last run end"
        >
          {formatLatency(timeline.spanMs)}
        </span>
      </div>
    </div>
  );
}
