import type { ReactNode } from 'react';

type PayloadSectionProps = {
  label: string;
  refId?: string;
  payloadCache: Record<string, unknown>;
  loadingRef: string | null;
  onLoad: (ref: string) => void;
  /** When set, used instead of default JSON.stringify for loaded payloads. */
  renderLoaded?: (data: unknown) => ReactNode;
};

export function PayloadSection(props: PayloadSectionProps): ReactNode {
  const { label, refId, payloadCache, loadingRef, onLoad, renderLoaded } = props;
  if (!refId) {
    return (
      <div className="mt-5 text-xs text-zinc-500">
        {label}: <em>no ref</em>
      </div>
    );
  }

  const loaded = payloadCache[refId] !== undefined;
  const data = loaded ? payloadCache[refId] : undefined;

  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-semibold text-zinc-100">{label}</span>
        <code className="truncate font-mono text-[11px] text-zinc-500">{refId}</code>
        {!loaded && (
          <button
            type="button"
            onClick={() => onLoad(refId)}
            disabled={loadingRef === refId}
            className="glass-chip ml-auto shrink-0 rounded-full px-3 py-1 text-xs font-medium text-zinc-100 transition-colors hover:text-violet-100 disabled:cursor-wait disabled:opacity-70"
          >
            {loadingRef === refId ? 'Loading...' : 'Load JSON'}
          </button>
        )}
      </div>
      {loaded &&
        (renderLoaded ? (
          renderLoaded(data)
        ) : (
          <pre className="glass-well m-0 max-h-80 overflow-auto rounded-2xl p-3 font-mono text-xs leading-relaxed text-zinc-300">
            {JSON.stringify(data, null, 2)}
          </pre>
        ))}
    </div>
  );
}
