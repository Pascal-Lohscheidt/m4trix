import { MagnifyingGlassIcon, SidebarSimpleIcon, XIcon } from '@phosphor-icons/react';
import { SettingsModalTrigger } from './SettingsModal';
import { Segmented } from './ui/Segmented';

export type LayoutFocus = 'run-tree' | 'detail';

type ToolbarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  layoutFocus: LayoutFocus;
  onLayoutFocusChange: (focus: LayoutFocus) => void;
  onOpenSettings: () => void;
};

export function Toolbar({
  query,
  onQueryChange,
  layoutFocus,
  onLayoutFocusChange,
  onOpenSettings,
}: ToolbarProps): React.ReactNode {
  return (
    <div className="grid h-14 shrink-0 grid-cols-[1fr_minmax(0,36rem)_1fr] items-center gap-3">
      <div />
      <label className="glass group flex h-11 items-center gap-2.5 rounded-full px-4 transition-shadow focus-within:shadow-[0_0_0_3px_rgb(167_139_250_/_0.25)]">
        <MagnifyingGlassIcon
          aria-hidden="true"
          weight="bold"
          className="h-4 w-4 shrink-0 text-zinc-500 transition-colors group-focus-within:text-violet-300"
        />
        <span className="sr-only">Search traces</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search traces by name, id, project or env"
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange('')}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100"
          >
            <XIcon aria-hidden="true" weight="bold" className="h-3.5 w-3.5" />
          </button>
        )}
      </label>
      <div className="flex items-center justify-end gap-2">
        <Segmented<LayoutFocus>
          legend="Layout focus"
          size="md"
          value={layoutFocus}
          onChange={onLayoutFocusChange}
          items={[
            {
              key: 'run-tree',
              ariaLabel: 'Focus run tree layout',
              title: 'Wide run tree',
              label: (
                <SidebarSimpleIcon
                  aria-hidden="true"
                  className="h-4 w-4 rotate-180"
                  weight="bold"
                />
              ),
            },
            {
              key: 'detail',
              ariaLabel: 'Focus run detail layout',
              title: 'Wide run detail',
              label: <SidebarSimpleIcon aria-hidden="true" className="h-4 w-4" weight="bold" />,
            },
          ]}
        />
        <SettingsModalTrigger onClick={onOpenSettings} />
      </div>
    </div>
  );
}
