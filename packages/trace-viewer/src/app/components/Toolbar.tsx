import { SidebarSimple } from '@phosphor-icons/react';
import { cx } from '../lib/viewer';

export type LayoutFocus = 'run-tree' | 'detail';

type ToolbarProps = {
  autoLoad: boolean;
  layoutFocus: LayoutFocus;
  onAutoLoadChange: (enabled: boolean) => void;
  onLayoutFocusChange: (focus: LayoutFocus) => void;
};

export function Toolbar({
  autoLoad,
  layoutFocus,
  onAutoLoadChange,
  onLayoutFocusChange,
}: ToolbarProps): React.ReactNode {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-5">
      <div>
        <div className="text-sm font-semibold text-zinc-100">Trace viewer</div>
        <div className="text-xs text-zinc-500">Inspect runs, metadata, and JSON payloads</div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex rounded-full border border-zinc-800 bg-zinc-900 p-0.5">
          <button
            type="button"
            aria-label="Focus run tree layout"
            aria-pressed={layoutFocus === 'run-tree'}
            onClick={() => onLayoutFocusChange('run-tree')}
            className={cx(
              'rounded-full px-2 py-1 text-zinc-500 transition-colors hover:text-zinc-200',
              layoutFocus === 'run-tree' && 'bg-zinc-800 text-amber-300',
            )}
          >
            <SidebarSimple aria-hidden="true" className="h-5 w-5 rotate-180" weight="bold" />
          </button>
          <button
            type="button"
            aria-label="Focus run detail layout"
            aria-pressed={layoutFocus === 'detail'}
            onClick={() => onLayoutFocusChange('detail')}
            className={cx(
              'rounded-full px-2 py-1 text-zinc-500 transition-colors hover:text-zinc-200',
              layoutFocus === 'detail' && 'bg-zinc-800 text-amber-300',
            )}
          >
            <SidebarSimple aria-hidden="true" className="h-5 w-5" weight="bold" />
          </button>
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
    </div>
  );
}
