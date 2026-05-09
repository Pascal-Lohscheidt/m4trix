import { getTraceEnv, statusTextClass } from '../lib/viewer';
import type { TraceRow } from '../types';

type TraceHeaderProps = {
  trace: TraceRow;
};

export function TraceHeader({ trace }: TraceHeaderProps): React.ReactNode {
  const env = getTraceEnv(trace);

  return (
    <header className="h-20 border-b border-zinc-800 bg-zinc-950 px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 truncate text-lg font-semibold text-zinc-50">
          {trace.name}
        </div>
        {env && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300">
            {env}
          </span>
        )}
      </div>
      <div className="mt-1.5 text-[13px] text-zinc-400">
        <span className={statusTextClass(trace.status)}>{trace.status}</span>
        {' · '}
        {trace.runCount} runs
        {trace.projectId ? ` · project ${trace.projectId}` : ''}
        {' · '}
        {trace.startTime}
      </div>
    </header>
  );
}
