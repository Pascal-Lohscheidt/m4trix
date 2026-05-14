import type { ReactNode } from 'react';
import { statusTextClass } from '../lib/viewer';
import { useViewerSettings } from '../state/viewer-settings-context';
import type { RunNode } from '../types';

type RunDetailProps = {
  run: RunNode | null;
  payloadCache: Record<string, unknown>;
  payloadLoading: string | null;
  onLoadPayload: (ref: string) => void;
};

export function RunDetail(props: RunDetailProps): ReactNode {
  const { run, payloadCache, payloadLoading, onLoadPayload } = props;
  const { activeProfile: profile } = useViewerSettings();

  return (
    <section className="col-start-3 row-start-3 h-full min-h-0 min-w-0 overflow-auto bg-zinc-900 p-4">
      <div className="mb-3 font-semibold text-zinc-200">Run detail</div>
      {!run && <div className="text-zinc-500">Select a run.</div>}
      {run && (
        <div className="text-[13px] text-zinc-300">
          <div>
            <strong className="text-zinc-50">{run.name}</strong>{' '}
            <span className="text-zinc-400">({run.type})</span>
          </div>
          <div className="mt-2">
            status: <span className={statusTextClass(run.status)}>{run.status}</span>
          </div>
          <div className="mt-1">start: {run.startTime}</div>
          {run.endTime && <div className="mt-1">end: {run.endTime}</div>}
          {run.latencyMs != null && <div className="mt-1">latency: {run.latencyMs} ms</div>}
          {run.error && <div className="mt-3 text-red-400">Error: {run.error.message}</div>}
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
      )}
    </section>
  );
}
