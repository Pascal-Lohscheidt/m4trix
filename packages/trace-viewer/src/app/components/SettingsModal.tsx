import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Switch,
  SwitchGroup,
  SwitchLabel,
} from '@headlessui/react';
import { GearIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { TRACE_PROFILES } from '../lib/trace-profiles';
import { cx } from '../lib/viewer';
import { AUTO_UPDATE_PRESETS, type AutoUpdatePreset } from '../lib/viewer-settings';
import { useViewerSettings } from '../state/viewer-settings-context';

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsModalTrigger({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open settings"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100"
    >
      <GearIcon aria-hidden="true" className="h-4 w-4" weight="bold" />
    </button>
  );
}

export function SettingsModal({ open, onClose }: SettingsModalProps): ReactNode {
  const { settings, updateSettings } = useViewerSettings();

  const setAutoLoad = (autoLoad: boolean) => updateSettings({ autoLoad });
  const setPreset = (autoUpdatePreset: AutoUpdatePreset) => updateSettings({ autoUpdatePreset });

  const autoUpdateOn = settings.autoUpdatePreset !== 'off';

  const setProfileEnabled = (
    profileId: (typeof TRACE_PROFILES)[number]['id'],
    enabled: boolean,
  ) => {
    const profile = TRACE_PROFILES.find((p) => p.id === profileId);
    if (!profile?.removable) return;
    const set = new Set(settings.enabledTraceProfileIds);
    if (enabled) set.add(profileId);
    else set.delete(profileId);
    updateSettings({
      enabledTraceProfileIds: [...set],
    });
  };

  return (
    <Dialog open={open} onClose={onClose} className="relative z-[100]">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-black/50 transition duration-150 ease-out data-closed:opacity-0"
      />
      <div className="fixed inset-0 flex w-screen items-center justify-center p-4">
        <DialogPanel
          transition
          className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl transition duration-150 ease-out data-closed:scale-95 data-closed:opacity-0"
        >
          <DialogTitle className="text-base font-semibold text-zinc-50">Settings</DialogTitle>
          <p className="mt-1 text-xs text-zinc-500">
            Auto-update refreshes the trace list on the interval you choose.
          </p>

          <SwitchGroup as="div" className="mt-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <SwitchLabel className="text-sm text-zinc-200">
                Auto load payloads
                <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">
                  Selected run input/output and trace-wide payloads for profile aggregates.
                </span>
              </SwitchLabel>
              <Switch
                checked={settings.autoLoad}
                onChange={setAutoLoad}
                className="group relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-zinc-700 bg-zinc-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 data-checked:border-amber-500/50 data-checked:bg-amber-500/25"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none inline-block h-5 w-5 translate-x-0.5 rounded-full bg-zinc-300 shadow transition group-data-checked:translate-x-5 group-data-checked:bg-amber-400"
                />
              </Switch>
            </div>

            <div className="flex items-center justify-between gap-4">
              <SwitchLabel className="text-sm text-zinc-200">Auto-update trace list</SwitchLabel>
              <Switch
                checked={autoUpdateOn}
                onChange={(checked) => {
                  if (checked)
                    setPreset(
                      settings.autoUpdatePreset === 'off' ? 's10' : settings.autoUpdatePreset,
                    );
                  else setPreset('off');
                }}
                className="group relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-zinc-700 bg-zinc-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 data-checked:border-amber-500/50 data-checked:bg-amber-500/25"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none inline-block h-5 w-5 translate-x-0.5 rounded-full bg-zinc-300 shadow transition group-data-checked:translate-x-5 group-data-checked:bg-amber-400"
                />
              </Switch>
            </div>
          </SwitchGroup>

          <div className="mt-6 border-t border-zinc-800 pt-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Trace profiles
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Enable alternate views for the trace header and run detail panels.{' '}
              <strong className="text-zinc-400">Raw</strong> is always available. Profiles that show
              trace-wide aggregates may need every run payload loaded—use auto load or the
              &quot;Load trace payloads&quot; action in the header.
            </p>
            <div className="mt-3 space-y-3">
              {TRACE_PROFILES.map((profile) => {
                if (!profile.removable) {
                  return (
                    <div
                      key={profile.id}
                      className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                    >
                      <div>
                        <div className="text-sm font-medium text-zinc-200">{profile.label}</div>
                        <div className="text-[11px] text-zinc-500">{profile.description}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-wide text-zinc-600">
                          Always on
                        </div>
                      </div>
                    </div>
                  );
                }
                const enabled = settings.enabledTraceProfileIds.includes(profile.id);
                return (
                  <div
                    key={profile.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-zinc-200">{profile.label}</div>
                      <div className="text-[11px] text-zinc-500">{profile.description}</div>
                    </div>
                    <Switch
                      checked={enabled}
                      onChange={(checked) => setProfileEnabled(profile.id, checked)}
                      className="group relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-zinc-700 bg-zinc-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 data-checked:border-violet-500/50 data-checked:bg-violet-500/20"
                    >
                      <span
                        aria-hidden="true"
                        className="pointer-events-none inline-block h-5 w-5 translate-x-0.5 rounded-full bg-zinc-300 shadow transition group-data-checked:translate-x-5 group-data-checked:bg-violet-300"
                      />
                    </Switch>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-4">
            <fieldset className="mt-0 border-0 p-0">
              <legend className="sr-only">Auto-update interval</legend>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Refresh interval
              </div>
              <div className="flex flex-wrap gap-1.5">
                {AUTO_UPDATE_PRESETS.map(({ value, label }) => {
                  const selected = settings.autoUpdatePreset === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPreset(value)}
                      className={cx(
                        'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                        selected
                          ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200',
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {!autoUpdateOn && (
              <p className="mt-2 text-[11px] text-zinc-600">
                Pick a non-Off interval to enable auto-update, or use the toggle above.
              </p>
            )}
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              Done
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
