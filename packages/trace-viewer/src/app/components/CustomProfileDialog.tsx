import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from '@headlessui/react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { validateMapping } from '../lib/payload-mapper/mapping-schema';
import { type CustomProfile, currentMapping } from '../lib/payload-mapper/profile-store';
import { cx } from '../lib/viewer';
import { useCustomProfiles } from '../state/custom-profiles-context';
import { JsonBlock } from './mapped-views/JsonBlock';

type CustomProfileDialogProps = {
  profile: CustomProfile | null;
  onClose: () => void;
};

const SOURCE_LABEL: Record<string, string> = {
  generated: 'AI generated',
  improved: 'AI improved',
  manual: 'Manual edit',
  imported: 'Imported',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

type Validation = { ok: true } | { ok: false; errors: string[] };

function validateText(text: string): Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON: ${(err as Error).message}`] };
  }
  const result = validateMapping(parsed);
  return result.ok ? { ok: true } : { ok: false, errors: result.errors };
}

const tabClass = ({ selected }: { selected: boolean }) =>
  cx(
    'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none',
    selected
      ? 'bg-violet-500/20 text-violet-200'
      : 'text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200',
  );

export function CustomProfileDialog({ profile, onClose }: CustomProfileDialogProps): ReactNode {
  const { saveVersion, restoreVersion, updateDetails } = useCustomProfiles();
  const savedText = useMemo(
    () => (profile ? JSON.stringify(currentMapping(profile), null, 2) : ''),
    [profile],
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');

  // Reset the form when switching profiles or after a new version becomes current.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `profile?.id` resets the form when switching between profiles with identical content
  useEffect(() => {
    setName(profile?.name ?? '');
    setDescription(profile?.description ?? '');
    setText(savedText);
    setNote('');
  }, [profile?.id, profile?.name, profile?.description, savedText]);

  const validation = useMemo(() => validateText(text), [text]);
  const mappingDirty = text.trim() !== savedText.trim();
  const detailsDirty =
    profile != null &&
    (name.trim() !== profile.name || description.trim() !== (profile.description ?? ''));

  const handleSave = () => {
    if (!profile) return;
    if (detailsDirty) updateDetails(profile.id, { name, description: description.trim() });
    if (mappingDirty && validation.ok) {
      const parsed = validateMapping(JSON.parse(text));
      if (parsed.ok)
        saveVersion(profile.id, parsed.mapping, {
          source: 'manual',
          note: note.trim() || undefined,
        });
    }
  };

  const versions = profile ? [...profile.versions].reverse() : [];

  return (
    <Dialog open={profile != null} onClose={onClose} className="relative z-[110]">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-[#07060f]/55 backdrop-blur-[6px] transition duration-150 ease-out data-closed:opacity-0"
      />
      <div className="fixed inset-0 flex w-screen items-center justify-center p-4">
        <DialogPanel
          transition
          className="flex max-h-[90vh] w-full max-w-3xl flex-col glass glass-strong rounded-[28px] p-6 transition duration-150 ease-out data-closed:scale-95 data-closed:opacity-0"
        >
          {profile && (
            <>
              <DialogTitle className="flex items-center gap-2 text-base font-semibold text-zinc-50">
                <span className="text-violet-300">✦</span>
                {profile.name}
                <span className="rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[11px] font-normal text-zinc-400">
                  v{profile.currentVersion}
                </span>
              </DialogTitle>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="text-xs text-zinc-400">
                  Name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-zinc-100 focus:border-violet-500/60 focus:outline-none"
                  />
                </label>
                <label className="text-xs text-zinc-400">
                  Description
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Shown in settings"
                    className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                  />
                </label>
              </div>

              <TabGroup className="mt-4 flex min-h-0 flex-1 flex-col">
                <TabList className="flex gap-1 rounded-xl border border-white/[0.07] bg-white/[0.04] p-0.5 self-start">
                  <Tab className={tabClass}>Mapping</Tab>
                  <Tab className={tabClass}>History ({profile.versions.length})</Tab>
                </TabList>
                <TabPanels className="mt-3 min-h-0 flex-1 overflow-auto">
                  <TabPanel className="space-y-2">
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      spellCheck={false}
                      aria-label="Mapping JSON"
                      className="h-[45vh] w-full resize-y rounded-xl border border-white/[0.07] bg-white/[0.04] p-2.5 font-mono text-xs text-zinc-200 focus:border-violet-500/60 focus:outline-none"
                    />
                    {validation.ok ? (
                      <div className="text-[11px] text-emerald-400/80">Valid mapping.</div>
                    ) : (
                      <ul className="m-0 max-h-28 list-none space-y-0.5 overflow-auto p-0 text-[11px] text-red-400">
                        {validation.errors.map((err) => (
                          <li key={err}>{err}</li>
                        ))}
                      </ul>
                    )}
                    {mappingDirty && (
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Version note (optional)"
                        className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
                      />
                    )}
                  </TabPanel>
                  <TabPanel>
                    <ol className="m-0 list-none space-y-2 p-0">
                      {versions.map((v) => {
                        const isCurrent = v.version === profile.currentVersion;
                        return (
                          <li
                            key={v.version}
                            className={cx(
                              'rounded-xl border px-3 py-2',
                              isCurrent
                                ? 'border-violet-500/40 bg-violet-500/5'
                                : 'border-white/[0.07] bg-white/[0.04]',
                            )}
                          >
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono font-semibold text-zinc-100">
                                v{v.version}
                              </span>
                              <span className="text-zinc-400">
                                {SOURCE_LABEL[v.source] ?? v.source}
                              </span>
                              {v.model && (
                                <span className="font-mono text-zinc-500">{v.model}</span>
                              )}
                              <span className="text-zinc-600">{formatDate(v.createdAt)}</span>
                              <span className="text-zinc-600">
                                · {v.mapping.rules.length} rules
                              </span>
                              {isCurrent ? (
                                <span className="ml-auto rounded-md bg-violet-500/20 px-1.5 py-0.5 text-[10px] uppercase text-violet-200">
                                  current
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => restoreVersion(profile.id, v.version)}
                                  className="ml-auto rounded-lg border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
                                >
                                  Restore
                                </button>
                              )}
                            </div>
                            {v.note && (
                              <div className="mt-1 text-[11px] text-zinc-400">{v.note}</div>
                            )}
                            <details className="mt-1 text-[11px]">
                              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                                Mapping JSON
                              </summary>
                              <JsonBlock value={v.mapping} className="mt-1 max-h-60" />
                            </details>
                          </li>
                        );
                      })}
                    </ol>
                  </TabPanel>
                </TabPanels>
              </TabGroup>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/[0.08]"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={!(detailsDirty || (mappingDirty && validation.ok))}
                  onClick={handleSave}
                  className="rounded-lg border border-violet-500/50 bg-violet-500/20 px-3 py-1.5 text-sm font-medium text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {mappingDirty
                    ? `Save as v${Math.max(...profile.versions.map((v) => v.version)) + 1}`
                    : 'Save'}
                </button>
              </div>
            </>
          )}
        </DialogPanel>
      </div>
    </Dialog>
  );
}
