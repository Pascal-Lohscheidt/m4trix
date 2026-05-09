import { statusTextClass } from '../lib/viewer';
import type { RunNode } from '../types';
import { PayloadSection } from './PayloadSection';

type RunDetailProps = {
  run: RunNode | null;
  payloadCache: Record<string, unknown>;
  payloadLoading: string | null;
  onLoadPayload: (ref: string) => void;
};

export function RunDetail(props: RunDetailProps): React.ReactNode {
  const { run, payloadCache, payloadLoading, onLoadPayload } = props;

  return (
    <section className="col-start-3 row-start-3 h-[calc(100vh-8rem)] min-w-0 overflow-auto bg-zinc-900 p-4">
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
          {run.metadata && Object.keys(run.metadata).length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 font-semibold">Metadata</div>
              <pre className="m-0 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs">
                {JSON.stringify(run.metadata, null, 2)}
              </pre>
            </div>
          )}
          <PayloadSection
            label="Input"
            refId={run.inputRef}
            payloadCache={payloadCache}
            loadingRef={payloadLoading}
            onLoad={onLoadPayload}
          />
          <PayloadSection
            label="Output"
            refId={run.outputRef}
            payloadCache={payloadCache}
            loadingRef={payloadLoading}
            onLoad={onLoadPayload}
          />
        </div>
      )}
    </section>
  );
}
