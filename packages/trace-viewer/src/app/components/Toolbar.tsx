type ToolbarProps = {
  autoLoad: boolean;
  onAutoLoadChange: (enabled: boolean) => void;
};

export function Toolbar({ autoLoad, onAutoLoadChange }: ToolbarProps): React.ReactNode {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-5">
      <div>
        <div className="text-sm font-semibold text-zinc-100">Trace viewer</div>
        <div className="text-xs text-zinc-500">Inspect runs, metadata, and JSON payloads</div>
      </div>
      <label className="flex cursor-pointer items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-700">
        <input
          type="checkbox"
          checked={autoLoad}
          onChange={(event) => onAutoLoadChange(event.target.checked)}
          className="h-4 w-4 accent-amber-400"
        />
        <span>Auto load</span>
      </label>
    </div>
  );
}
