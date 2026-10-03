import { Switch } from '@headlessui/react';
import {
  CopyIcon,
  DownloadSimpleIcon,
  PencilSimpleIcon,
  SparkleIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { type ChangeEvent, type ReactNode, useState } from 'react';
import { STARTER_MAPPING } from '../lib/payload-mapper/mapping-schema';
import {
  type CustomProfile,
  exportProfile,
  toTraceProfileId,
} from '../lib/payload-mapper/profile-store';
import type { TraceProfileId } from '../lib/trace-profiles';
import { useCustomProfiles } from '../state/custom-profiles-context';
import { useMapperDialog } from '../state/mapper-dialog-context';
import { useViewerSettings } from '../state/viewer-settings-context';
import { CustomProfileDialog } from './CustomProfileDialog';

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'profile'
  );
}

const iconButton =
  'inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-zinc-200';

export function CustomProfilesSection(): ReactNode {
  const { profiles, warnings, createProfile, duplicateProfile, removeProfile, importProfileJson } =
    useCustomProfiles();
  const { settings, updateSettings } = useViewerSettings();
  const mapper = useMapperDialog();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const editing = profiles.find((p) => p.id === editingId) ?? null;

  const enableAndActivate = (profile: CustomProfile) => {
    const id = toTraceProfileId(profile.id);
    updateSettings({
      enabledTraceProfileIds: [...settings.enabledTraceProfileIds, id],
      activeTraceProfileId: id,
    });
  };

  const setEnabled = (id: TraceProfileId, enabled: boolean) => {
    const set = new Set(settings.enabledTraceProfileIds);
    if (enabled) set.add(id);
    else set.delete(id);
    updateSettings({ enabledTraceProfileIds: [...set] });
  };

  const handleNew = () => {
    const profile = createProfile({
      name: `Custom profile ${profiles.length + 1}`,
      mapping: STARTER_MAPPING,
      source: 'manual',
      note: 'Created from starter mapping',
    });
    enableAndActivate(profile);
    setEditingId(profile.id);
  };

  const handleImport = (json: string, fallbackName?: string) => {
    const result = importProfileJson(json, fallbackName);
    if (!result.ok) {
      setImportErrors(result.errors);
      return;
    }
    enableAndActivate(result.profile);
    setImportOpen(false);
    setImportText('');
    setImportErrors([]);
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    handleImport(
      await file.text(),
      file.name.replace(/\.json$/i, '').replace(/\.m4trix-profile$/i, ''),
    );
  };

  const handleDuplicate = (id: string) => {
    const copy = duplicateProfile(id);
    if (copy) enableAndActivate(copy);
  };

  const handleDelete = (id: string) => {
    const traceId = toTraceProfileId(id);
    removeProfile(id);
    updateSettings({
      enabledTraceProfileIds: settings.enabledTraceProfileIds.filter((p) => p !== traceId),
    });
    setConfirmDeleteId(null);
  };

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Custom profiles
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setImportOpen((v) => !v);
              setImportErrors([]);
            }}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
          >
            Import
          </button>
          <button
            type="button"
            onClick={handleNew}
            title="Start from a hand-editable starter mapping"
            className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
          >
            New blank
          </button>
          {mapper && (
            <button
              type="button"
              onClick={() => mapper.openMapper({ mode: 'create' })}
              className="rounded-lg border border-violet-500/40 bg-violet-500/15 px-2 py-1 text-[11px] font-medium text-violet-200 hover:bg-violet-500/25"
            >
              ✦ Generate with AI
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Mapped profiles render payloads as messages, tool calls and tables using a JSON mapping.
        Saved in this browser; export to share.
      </p>

      {warnings.length > 0 && (
        <ul className="mt-2 list-none space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {importOpen && (
        <div className="mt-3 space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.04] p-3">
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste an exported profile or a mapping JSON…"
            spellCheck={false}
            aria-label="Profile JSON"
            className="h-28 w-full resize-y rounded-lg border border-white/[0.07] bg-black/25 p-2 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none"
          />
          {importErrors.length > 0 && (
            <ul className="m-0 max-h-24 list-none space-y-0.5 overflow-auto p-0 text-[11px] text-red-400">
              {importErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between">
            <label className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={handleFile}
              />
              Choose file…
            </label>
            <button
              type="button"
              disabled={!importText.trim()}
              onClick={() => handleImport(importText)}
              className="rounded-lg border border-violet-500/40 bg-violet-500/15 px-2.5 py-1 text-[11px] font-medium text-violet-200 hover:bg-violet-500/25 disabled:opacity-40"
            >
              Import JSON
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {profiles.length === 0 && !importOpen && (
          <div className="rounded-xl border border-dashed border-white/[0.07] px-3 py-3 text-center text-[11px] text-zinc-600">
            No custom profiles yet.
          </div>
        )}
        {profiles.map((profile) => {
          const traceId = toTraceProfileId(profile.id);
          const enabled = settings.enabledTraceProfileIds.includes(traceId);
          const rules = profile.versions.find((v) => v.version === profile.currentVersion)?.mapping
            .rules.length;
          return (
            <div
              key={profile.id}
              className="rounded-xl border border-white/[0.07] bg-white/[0.04] px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-zinc-200">
                    <span className="mr-1 text-violet-300">✦</span>
                    {profile.name}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {profile.description ? `${profile.description} · ` : ''}v
                    {profile.currentVersion} · {rules} rule{rules === 1 ? '' : 's'}
                  </div>
                </div>
                <Switch
                  checked={enabled}
                  onChange={(checked) => setEnabled(traceId, checked)}
                  aria-label={`Show ${profile.name} profile`}
                  className="group relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-white/10 bg-white/[0.07] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/80 data-checked:border-violet-500/50 data-checked:bg-violet-500/20"
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none inline-block h-5 w-5 translate-x-0.5 rounded-full bg-zinc-300 shadow transition group-data-checked:translate-x-5 group-data-checked:bg-violet-300"
                  />
                </Switch>
              </div>
              <div className="mt-1.5 flex items-center gap-0.5">
                {mapper && (
                  <button
                    type="button"
                    title="Re-sample traces and improve with AI"
                    aria-label="Improve with AI"
                    className={`${iconButton} hover:text-violet-200`}
                    onClick={() => mapper.openMapper({ mode: 'improve', profileId: profile.id })}
                  >
                    <SparkleIcon className="h-3.5 w-3.5" weight="bold" />
                  </button>
                )}
                <button
                  type="button"
                  title="Edit mapping & history"
                  aria-label="Edit"
                  className={iconButton}
                  onClick={() => setEditingId(profile.id)}
                >
                  <PencilSimpleIcon className="h-3.5 w-3.5" weight="bold" />
                </button>
                <button
                  type="button"
                  title="Duplicate"
                  aria-label="Duplicate"
                  className={iconButton}
                  onClick={() => handleDuplicate(profile.id)}
                >
                  <CopyIcon className="h-3.5 w-3.5" weight="bold" />
                </button>
                <button
                  type="button"
                  title="Export JSON"
                  aria-label="Export"
                  className={iconButton}
                  onClick={() =>
                    downloadJson(
                      `${slug(profile.name)}.m4trix-profile.json`,
                      exportProfile(profile),
                    )
                  }
                >
                  <DownloadSimpleIcon className="h-3.5 w-3.5" weight="bold" />
                </button>
                {confirmDeleteId === profile.id ? (
                  <span className="ml-auto flex items-center gap-1.5 text-[11px]">
                    <span className="text-zinc-400">Delete profile and history?</span>
                    <button
                      type="button"
                      onClick={() => handleDelete(profile.id)}
                      className="rounded-md px-1.5 py-0.5 text-red-300 hover:bg-red-500/15"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-md px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.08]"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    title="Delete"
                    aria-label="Delete"
                    className={`${iconButton} ml-auto hover:text-red-300`}
                    onClick={() => setConfirmDeleteId(profile.id)}
                  >
                    <TrashIcon className="h-3.5 w-3.5" weight="bold" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <CustomProfileDialog profile={editing} onClose={() => setEditingId(null)} />
    </div>
  );
}
