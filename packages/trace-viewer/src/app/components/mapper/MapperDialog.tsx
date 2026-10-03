import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { client } from '../../api/client';
import { type CollectResult, collectSampleGroups } from '../../lib/payload-mapper/collect';
import { type CoverageReport, coverageForSamples } from '../../lib/payload-mapper/coverage';
import {
  type GenerationEvent,
  GenerationError,
  type GenerationResult,
  runMappingGeneration,
} from '../../lib/payload-mapper/generate';
import {
  type CoverageSnapshot,
  currentMapping,
  fromStoredSamples,
  latestSamples,
  toStoredSamples,
  toTraceProfileId,
} from '../../lib/payload-mapper/profile-store';
import { createProvider, PROVIDERS, ProviderError } from '../../lib/payload-mapper/providers';
import { diffMappings } from '../../lib/payload-mapper/rule-diff';
import {
  applyLimits,
  DEFAULT_TRUNCATE_LIMITS,
  estimateTokens,
  fitToBudget,
  sampleGroupChars,
} from '../../lib/payload-mapper/sampling';
import { cx } from '../../lib/viewer';
import { useCustomProfiles } from '../../state/custom-profiles-context';
import type { MapperDialogRequest } from '../../state/mapper-dialog-context';
import { useMapperProvider } from '../../state/mapper-provider-context';
import { useViewerSettings } from '../../state/viewer-settings-context';
import type { RunNode, TraceRow, TraceTree } from '../../types';
import { JsonBlock } from '../mapped-views/JsonBlock';
import { CoverageSummary, GroupStatus } from './CoverageSummary';
import { ProviderSettingsPanel } from './ProviderSettingsPanel';
import { RouteDiagram } from './RouteDiagram';
import { RuleDiffList } from './RuleDiffList';
import { SamplePreview } from './SamplePreview';

/** Prompt budget for samples (~30k tokens). */
const MAX_PROMPT_CHARS = 120_000;
const RECENT_OPTIONS = [5, 10, 25, 50];

type Step = 'setup' | 'collecting' | 'review' | 'generating' | 'preview' | 'error';

export type MapperDialogProps = {
  request: MapperDialogRequest;
  onClose: () => void;
  traces: TraceRow[];
  currentTraceId: string | null;
  currentTree: TraceTree | null;
  payloadCache: Record<string, unknown>;
};

const button =
  'rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40';
const primary =
  'rounded-md border border-violet-500/50 bg-violet-500/20 px-3 py-1.5 text-sm font-medium text-violet-100 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40';
const inputClass =
  'w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none';

function snapshot(report: CoverageReport): CoverageSnapshot {
  const { score, total, mapped, partial, fallback, unmatched } = report;
  return { score, total, mapped, partial, fallback, unmatched };
}

function describeEvent(event: GenerationEvent): string {
  switch (event.type) {
    case 'request':
      return event.repair
        ? `Attempt ${event.attempt}: asking for a repair…`
        : `Attempt ${event.attempt}: generating mapping…`;
    case 'response':
      return `Attempt ${event.attempt}: received${event.outputTokens ? ` (${event.outputTokens} output tokens)` : ''}`;
    case 'problems':
      return `Attempt ${event.attempt}: ${event.problems.length} problem${event.problems.length === 1 ? '' : 's'} found`;
  }
}

export function MapperDialog({
  request,
  onClose,
  traces,
  currentTraceId,
  currentTree,
  payloadCache,
}: MapperDialogProps): ReactNode {
  const { profiles, createProfile, saveVersion } = useCustomProfiles();
  const { settings: viewerSettings, updateSettings } = useViewerSettings();
  const { config, problems: providerProblems, settings: providerSettings } = useMapperProvider();

  const profile =
    request.mode === 'improve' ? (profiles.find((p) => p.id === request.profileId) ?? null) : null;
  const current = profile ? currentMapping(profile) : undefined;
  const pinnedRefs = request.mode === 'improve' ? (request.pinnedRefs ?? []) : [];

  const [step, setStep] = useState<Step>('setup');
  const [scope, setScope] = useState<'current' | 'recent'>(currentTraceId ? 'current' : 'recent');
  const [recentCount, setRecentCount] = useState(10);
  const [perGroup, setPerGroup] = useState(3);
  const [instruction, setInstruction] = useState('');
  const [showProvider, setShowProvider] = useState(false);
  const [progress, setProgress] = useState('');
  const [collected, setCollected] = useState<CollectResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [redact, setRedact] = useState(false);
  const [events, setEvents] = useState<GenerationEvent[]>([]);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<{
    message: string;
    detail?: string;
    problems?: string[];
  } | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const providerInfo = PROVIDERS[config.provider];
  const regressionGroups = useMemo(
    () => (profile ? fromStoredSamples(latestSamples(profile)) : []),
    [profile],
  );

  // --- review derived state ---------------------------------------------------------------
  const limitedGroups = useMemo(
    () =>
      (collected?.groups ?? []).map((g) =>
        applyLimits(g, { ...DEFAULT_TRUNCATE_LIMITS, redactStrings: redact }),
      ),
    [collected, redact],
  );
  const currentCoverage = useMemo(
    () => (current && collected ? coverageForSamples(current, collected.groups) : null),
    [current, collected],
  );
  const currentByKey = useMemo(
    () => new Map((currentCoverage?.groups ?? []).map((g) => [g.key, g])),
    [currentCoverage],
  );
  const toSend = useMemo(
    () =>
      fitToBudget(
        limitedGroups.filter((g) => selected.has(g.key)),
        MAX_PROMPT_CHARS,
      ),
    [limitedGroups, selected],
  );
  const sendChars = toSend.reduce((n, g) => n + sampleGroupChars(g), 0);
  const sendSamples = toSend.reduce((n, g) => n + g.samples.length, 0);
  const selectedSamples = limitedGroups
    .filter((g) => selected.has(g.key))
    .reduce((n, g) => n + g.samples.length, 0);

  const traceIds = useMemo(() => {
    if (scope === 'current' && currentTraceId) return [currentTraceId];
    return traces.slice(0, recentCount).map((t) => t.traceId);
  }, [scope, currentTraceId, traces, recentCount]);

  // --- actions ----------------------------------------------------------------------------
  const handleCollect = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStep('collecting');
    setProgress('Loading traces…');
    try {
      const res = await collectSampleGroups({
        traceIds,
        perGroup,
        pinnedRefs,
        signal: controller.signal,
        knownTrees:
          currentTree && currentTraceId
            ? { [currentTraceId]: { root: currentTree.root } }
            : undefined,
        knownPayloads: payloadCache,
        deps: {
          getTree: async (traceId) => {
            const r = await client.traces.getTree.query({ traceId });
            return r ? { root: r.root as RunNode } : null;
          },
          getPayload: (ref) => client.traces.getPayload.query({ ref }),
        },
        onProgress: (p) =>
          setProgress(
            p.phase === 'trees'
              ? `Loading traces ${p.done}/${p.total}…`
              : `Loading payloads ${p.done}/${p.total}…`,
          ),
      });
      setCollected(res);
      // Create: everything. Improve: groups that are not cleanly mapped yet, plus pinned runs.
      const pinnedSet = new Set(pinnedRefs);
      const initial = res.groups.filter((g) => {
        if (!current) return true;
        if (g.samples.some((s) => pinnedSet.has(s.ref))) return true;
        const cov = coverageForSamples(current, [g]).groups[0];
        return !cov || cov.mapped < cov.total;
      });
      setSelected(new Set((initial.length > 0 ? initial : res.groups).map((g) => g.key)));
      setStep('review');
    } catch (err) {
      if (controller.signal.aborted) setStep('setup');
      else {
        setError({ message: `Could not collect samples: ${(err as Error).message}` });
        setStep('error');
      }
    }
  };

  const handleGenerate = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setEvents([]);
    setStep('generating');
    try {
      const provider = await createProvider(config);
      const res = await runMappingGeneration({
        provider,
        mode: request.mode,
        groups: toSend,
        current,
        regressionGroups,
        instruction,
        signal: controller.signal,
        onProgress: (e) => setEvents((prev) => [...prev, e]),
      });
      setResult(res);
      setName(res.name || profile?.name || 'AI profile');
      setDescription(res.description ?? profile?.description ?? '');
      setStep('preview');
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'aborted') {
        setStep('review');
        return;
      }
      if (err instanceof GenerationError) {
        setError({
          message: err.message,
          detail: err.lastAnswer,
          problems: err.attempts.at(-1)?.problems,
        });
      } else if (err instanceof ProviderError) {
        setError({ message: `${providerInfo.label} error (${err.kind}): ${err.message}` });
      } else {
        setError({ message: String(err) });
      }
      setStep('error');
    }
  };

  const handleSave = () => {
    if (!result) return;
    const meta = {
      provider: config.provider,
      model: config.model,
      note: result.changes.join('; ') || undefined,
      coverage: snapshot(result.coverage),
      samples: providerSettings.keepSamples ? toStoredSamples(toSend) : undefined,
    };
    let profileId: string;
    if (profile) {
      saveVersion(profile.id, result.mapping, { ...meta, source: 'improved' });
      profileId = profile.id;
    } else {
      profileId = createProfile({
        name,
        description: description || undefined,
        mapping: result.mapping,
        ...meta,
        source: 'generated',
      }).id;
    }
    const traceProfileId = toTraceProfileId(profileId);
    updateSettings({
      enabledTraceProfileIds: [
        ...new Set([...viewerSettings.enabledTraceProfileIds, traceProfileId]),
      ],
      activeTraceProfileId: traceProfileId,
    });
    onClose();
  };

  const cancel = () => abortRef.current?.abort();

  const diff = result && current ? diffMappings(current, result.mapping) : null;
  const previewGroups = useMemo(
    () => [...toSend, ...regressionGroups.filter((g) => !toSend.some((s) => s.key === g.key))],
    [toSend, regressionGroups],
  );

  // --- render -----------------------------------------------------------------------------
  const title = profile ? `Improve “${profile.name}”` : 'New AI profile';

  return (
    <Dialog
      open
      onClose={step === 'generating' || step === 'collecting' ? () => undefined : onClose}
      className="relative z-[120]"
    >
      <DialogBackdrop className="fixed inset-0 bg-black/60" />
      <div className="fixed inset-0 flex w-screen items-center justify-center p-4">
        <DialogPanel className="flex max-h-[92vh] w-full max-w-5xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-zinc-50">
            <span className="text-violet-300">✦</span>
            {title}
            <span className="ml-auto flex gap-1 text-[10px] font-normal uppercase tracking-wide">
              {(['setup', 'review', 'preview'] as const).map((s, i) => {
                const order = {
                  setup: 0,
                  collecting: 0,
                  review: 1,
                  generating: 1,
                  error: 1,
                  preview: 2,
                }[step];
                return (
                  <span
                    key={s}
                    className={cx(
                      'rounded px-1.5 py-0.5',
                      order === i ? 'bg-violet-500/20 text-violet-200' : 'text-zinc-600',
                    )}
                  >
                    {i + 1}.{' '}
                    {s === 'setup' ? 'Sample' : s === 'review' ? 'Review & send' : 'Preview'}
                  </span>
                );
              })}
            </span>
          </DialogTitle>

          <div className="mt-4 min-h-0 flex-1 overflow-auto pr-1">
            {step === 'setup' && (
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
                <div className="space-y-4">
                  <fieldset className="m-0 space-y-2 border-0 p-0">
                    <legend className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                      Traces to sample
                    </legend>
                    <label
                      className={cx(
                        'flex items-center gap-2 text-sm',
                        !currentTraceId && 'opacity-40',
                      )}
                    >
                      <input
                        type="radio"
                        checked={scope === 'current'}
                        disabled={!currentTraceId}
                        onChange={() => setScope('current')}
                        className="accent-violet-400"
                      />
                      Current trace
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        checked={scope === 'recent'}
                        onChange={() => setScope('recent')}
                        className="accent-violet-400"
                      />
                      Last
                      <select
                        value={recentCount}
                        onChange={(e) => setRecentCount(Number(e.target.value))}
                        className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
                      >
                        {RECENT_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      traces{' '}
                      <span className="text-[11px] text-zinc-500">
                        ({traces.length} in the list)
                      </span>
                    </label>
                  </fieldset>
                  <label className="flex items-center gap-2 text-sm">
                    Samples per group
                    <select
                      value={perGroup}
                      onChange={(e) => setPerGroup(Number(e.target.value))}
                      className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  {pinnedRefs.length > 0 && (
                    <div className="rounded-md border border-violet-500/30 bg-violet-500/5 px-2 py-1.5 text-[11px] text-violet-200">
                      Includes the run you picked ({pinnedRefs.length} payload).
                    </div>
                  )}
                  <label className="block text-[11px] text-zinc-400">
                    Instructions (optional)
                    <textarea
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      rows={4}
                      placeholder={
                        profile
                          ? 'e.g. show tool args as a table, collapse system prompts'
                          : 'e.g. focus on the agent conversation, show retrieval hits as a table'
                      }
                      className={`${inputClass} mt-1 resize-y`}
                    />
                  </label>
                  {profile && (
                    <div className="text-[11px] text-zinc-500">
                      Current version v{profile.currentVersion} · {current?.rules.length} rules
                      {regressionGroups.length > 0 &&
                        ` · ${regressionGroups.reduce((n, g) => n + g.samples.length, 0)} stored samples will be re-checked for regressions`}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                      Provider
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowProvider((v) => !v)}
                      className="text-[11px] text-violet-300 hover:text-violet-200"
                    >
                      {showProvider ? 'Hide' : 'Change'}
                    </button>
                  </div>
                  {showProvider || providerProblems.length > 0 ? (
                    <ProviderSettingsPanel compact />
                  ) : (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-300">
                      {providerInfo.label} · <span className="font-mono">{config.model}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === 'collecting' && (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-zinc-400">
                <span className="animate-pulse">{progress}</span>
              </div>
            )}

            {step === 'review' && collected && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
                  <span>
                    {collected.scannedTraces} trace{collected.scannedTraces === 1 ? '' : 's'}{' '}
                    scanned · {collected.allGroups.length} payload groups
                    {collected.failedPayloads > 0 &&
                      ` · ${collected.failedPayloads} payloads failed to load`}
                  </span>
                  <button
                    type="button"
                    className="text-violet-300 hover:text-violet-200"
                    onClick={() => setSelected(new Set(limitedGroups.map((g) => g.key)))}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-violet-300 hover:text-violet-200"
                    onClick={() => setSelected(new Set())}
                  >
                    None
                  </button>
                  <label className="ml-auto flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={redact}
                      onChange={(e) => setRedact(e.target.checked)}
                      className="accent-violet-400"
                    />
                    Redact strings longer than 40 chars
                  </label>
                </div>
                <div className="overflow-hidden rounded-lg border border-zinc-800">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="bg-zinc-900 text-[11px] text-zinc-500">
                      <tr>
                        <th className="w-8 px-2 py-1.5" />
                        <th className="px-2 py-1.5 font-medium">Payload group</th>
                        <th className="px-2 py-1.5 font-medium">Runs</th>
                        <th className="px-2 py-1.5 font-medium">Samples</th>
                        <th className="px-2 py-1.5 font-medium">~Tokens</th>
                        {current && <th className="px-2 py-1.5 font-medium">Current</th>}
                        <th className="px-2 py-1.5 font-medium">Sent data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {limitedGroups.map((g) => (
                        <tr key={g.key} className="border-t border-zinc-900 align-top">
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox"
                              aria-label={`Send ${g.key}`}
                              checked={selected.has(g.key)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(g.key);
                                else next.delete(g.key);
                                setSelected(next);
                              }}
                              className="accent-violet-400"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <span className="text-zinc-500">{g.runType}</span>{' '}
                            <span className="text-zinc-200">{g.runName}</span>{' '}
                            <span className="text-zinc-600">{g.side}</span>
                          </td>
                          <td className="px-2 py-1.5 text-zinc-400">{g.runCount}</td>
                          <td className="px-2 py-1.5 text-zinc-400">{g.samples.length}</td>
                          <td className="px-2 py-1.5 font-mono text-zinc-400">
                            {estimateTokens(sampleGroupChars(g)).toLocaleString()}
                          </td>
                          {current && (
                            <td className="px-2 py-1.5">
                              <GroupStatus group={currentByKey.get(g.key)} />
                            </td>
                          )}
                          <td className="px-2 py-1.5">
                            <details>
                              <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">
                                inspect
                              </summary>
                              <div className="mt-1 max-w-md space-y-1">
                                <code className="block whitespace-pre-wrap break-all text-[10px] text-zinc-500">
                                  {g.shape}
                                </code>
                                <JsonBlock
                                  value={g.samples[0]?.payload}
                                  className="max-h-48 text-[10px]"
                                />
                              </div>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4">
                  <div className="space-y-1 text-xs text-zinc-400">
                    <div className="text-sm text-zinc-200">
                      {toSend.length} groups · {sendSamples} samples · ~
                      {estimateTokens(sendChars).toLocaleString()} tokens
                    </div>
                    {sendSamples < selectedSamples && (
                      <div className="text-amber-300/80">
                        Trimmed {selectedSamples - sendSamples} samples to stay within the ~
                        {estimateTokens(MAX_PROMPT_CHARS).toLocaleString()} token budget.
                      </div>
                    )}
                    <div className="text-zinc-500">
                      Strings are cut at 500 chars and arrays at 20 items before sending.
                    </div>
                  </div>
                  <RouteDiagram
                    config={config}
                    rememberKeys={providerSettings.rememberKeys}
                    compact
                    payloadSummary={`${sendSamples} truncated payload samples (~${estimateTokens(sendChars).toLocaleString()} tokens)${current ? ' and the current mapping' : ''}`}
                  />
                </div>
              </div>
            )}

            {step === 'generating' && (
              <div className="space-y-2 py-6">
                <div className="animate-pulse text-sm text-zinc-300">
                  Waiting for {providerInfo.label} ({config.model})…
                </div>
                <ol className="m-0 list-none space-y-1 p-0 text-xs text-zinc-400">
                  {events.map((e, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: append-only event log
                    <li key={i}>
                      {describeEvent(e)}
                      {e.type === 'problems' && (
                        <ul className="mt-0.5 list-disc pl-5 text-[11px] text-amber-300/80">
                          {e.problems.slice(0, 5).map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {step === 'error' && error && (
              <div className="space-y-3">
                <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
                  {error.message}
                </div>
                {error.problems && error.problems.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-400">
                    {error.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {error.detail && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-zinc-400">Last model answer</summary>
                    <JsonBlock value={error.detail} className="mt-1" />
                  </details>
                )}
              </div>
            )}

            {step === 'preview' && result && (
              <div className="space-y-4">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
                  <div className="space-y-3">
                    <CoverageSummary after={result.coverage} before={result.before} />
                    {result.unresolved.length > 0 && (
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200">
                        <div className="mb-1 font-medium">
                          Still unresolved after repairs — you can save and fix them later:
                        </div>
                        <ul className="m-0 list-disc space-y-0.5 pl-4">
                          {result.unresolved.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="text-[11px] text-zinc-500">
                      {result.attempts.length} attempt{result.attempts.length === 1 ? '' : 's'} ·{' '}
                      {result.usage.inputTokens.toLocaleString()} in /{' '}
                      {result.usage.outputTokens.toLocaleString()} out tokens
                    </div>
                  </div>
                  <div className="space-y-2">
                    {!profile && (
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-[11px] text-zinc-400">
                          Name
                          <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className={`${inputClass} mt-1`}
                          />
                        </label>
                        <label className="text-[11px] text-zinc-400">
                          Description
                          <input
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            className={`${inputClass} mt-1`}
                          />
                        </label>
                      </div>
                    )}
                    {result.changes.length > 0 && (
                      <ul className="m-0 list-disc space-y-0.5 pl-4 text-xs text-zinc-300">
                        {result.changes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    )}
                    {diff && <RuleDiffList diff={diff} />}
                  </div>
                </div>
                <SamplePreview
                  groups={previewGroups}
                  after={result.mapping}
                  afterCoverage={result.coverage}
                  before={current}
                  beforeCoverage={result.before}
                />
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-zinc-900 pt-3">
            {(step === 'collecting' || step === 'generating') && (
              <button type="button" className={button} onClick={cancel}>
                Cancel
              </button>
            )}
            {step === 'setup' && (
              <>
                <button type="button" className={button} onClick={onClose}>
                  Close
                </button>
                <button
                  type="button"
                  className={primary}
                  disabled={traceIds.length === 0}
                  onClick={handleCollect}
                >
                  Collect samples
                </button>
              </>
            )}
            {step === 'review' && (
              <>
                <button type="button" className={button} onClick={() => setStep('setup')}>
                  Back
                </button>
                <button
                  type="button"
                  className={primary}
                  disabled={toSend.length === 0 || providerProblems.length > 0}
                  title={providerProblems.join('\n') || undefined}
                  onClick={handleGenerate}
                >
                  Send to {providerInfo.label}
                </button>
              </>
            )}
            {step === 'error' && (
              <>
                <button type="button" className={button} onClick={onClose}>
                  Close
                </button>
                <button
                  type="button"
                  className={primary}
                  onClick={() => setStep(collected ? 'review' : 'setup')}
                >
                  Back
                </button>
              </>
            )}
            {step === 'preview' && result && (
              <>
                <button type="button" className={button} onClick={() => setStep('review')}>
                  Back & regenerate
                </button>
                <button
                  type="button"
                  className={primary}
                  disabled={!profile && !name.trim()}
                  onClick={handleSave}
                >
                  {profile
                    ? `Save as v${Math.max(...profile.versions.map((v) => v.version)) + 1}`
                    : 'Save profile'}
                </button>
              </>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
