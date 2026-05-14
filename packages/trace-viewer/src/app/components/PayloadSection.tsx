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
      <div className="mt-4 text-zinc-500">
        {label}: <em>no ref</em>
      </div>
    );
  }

  const loaded = payloadCache[refId] !== undefined;
  const data = loaded ? payloadCache[refId] : undefined;

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold">{label}</span>
        <code className="truncate text-[11px] text-zinc-400">{refId}</code>
        {!loaded && (
          <button
            type="button"
            onClick={() => onLoad(refId)}
            disabled={loadingRef === refId}
            className="ml-auto rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-50 transition-colors hover:border-zinc-600 hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70"
          >
            {loadingRef === refId ? 'Loading...' : 'Load JSON'}
          </button>
        )}
      </div>
      {loaded &&
        (renderLoaded ? (
          renderLoaded(data)
        ) : (
          <pre className="m-0 max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        ))}
    </div>
  );
}
