import { WarningCircleIcon } from '@phosphor-icons/react';
import { type ReactNode, useRef } from 'react';
import { useReveal } from '../lib/motion';
import { cx, formatLatency, formatTimestamp, statusDotClass, statusTextClass } from '../lib/viewer';
import { useViewerSettings } from '../state/viewer-settings-context';
import type { RunNode } from '../types';
import { GlassCard } from './ui/GlassCard';

type RunDetailProps = {
  run: RunNode | null;
  payloadCache: Record<string, unknown>;
  payloadLoading: string | null;
  onLoadPayload: (ref: string) => void;
};

export function RunDetail(props: RunDetailProps): ReactNode {
  const { run, payloadCache, payloadLoading, onLoadPayload } = props;
  const { activeProfile: profile } = useViewerSettings();
  const bodyRef = useRef<HTMLDivElement>(null);
  useReveal(bodyRef, run?.runId, { distance: 8, staggerMs: 45 });

  return (
    <GlassCard title="Run detail" bodyRef={bodyRef} className="min-w-[300px]">
      {!run && <div className="px-2 text-sm text-zinc-500">Select a run in the tree.</div>}
      {run && (
        <div className="px-2 text-[13px] text-zinc-300">
          <div data-reveal>
            <div className="text-xl leading-snug font-semibold tracking-tight break-words text-zinc-50">
              {run.name}
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">{run.type}</div>
          </div>

          <dl data-reveal className="mt-4 grid grid-cols-2 gap-2">
            <Stat label="Status">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cx('h-1.5 w-1.5 rounded-full', statusDotClass(run.status))}
                />
                <span className={statusTextClass(run.status)}>{run.status}</span>
              </span>
            </Stat>
            <Stat label="Latency">
              {run.latencyMs != null ? formatLatency(run.latencyMs) : '—'}
            </Stat>
            <Stat label="Start" title={run.startTime}>
              {formatTimestamp(run.startTime)}
            </Stat>
            <Stat label="End" title={run.endTime}>
              {run.endTime ? formatTimestamp(run.endTime) : '—'}
            </Stat>
          </dl>

          {run.error && (
            <div
              data-reveal
              className="mt-3 flex gap-2 rounded-2xl bg-rose-500/10 p-3 text-rose-200 ring-1 ring-rose-400/20 ring-inset"
            >
              <WarningCircleIcon
                aria-hidden="true"
                weight="fill"
                className="mt-px h-4 w-4 shrink-0 text-rose-400"
              />
              <div className="min-w-0 break-words">
                {run.error.type && (
                  <div className="font-medium text-rose-100">{run.error.type}</div>
                )}
                {run.error.message}
              </div>
            </div>
          )}
          <div data-reveal>
            {profile.renderMetadata({
              run,
              payloadCache,
              payloadLoading,
              onLoadPayload,
            })}
            {profile.renderInput({
              run,
              payloadCache,
              payloadLoading,
              onLoadPayload,
            })}
            {profile.renderOutput({
              run,
              payloadCache,
              payloadLoading,
              onLoadPayload,
            })}
          </div>
        </div>
      )}
    </GlassCard>
  );
}

function Stat({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="glass-well min-w-0 rounded-2xl px-3 py-2" title={title}>
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="m-0 mt-0.5 truncate text-[13px] font-medium text-zinc-100 tabular-nums">
        {children}
      </dd>
    </div>
  );
}
