import { type ReactNode, useRef, useState } from 'react';
import {
  PROVIDER_ORDER,
  PROVIDERS,
  ProviderError,
  testProviderConnection,
} from '../../lib/payload-mapper/providers';
import type { ProviderCredentials } from '../../lib/payload-mapper/providers/types';
import { cx } from '../../lib/viewer';
import { useMapperProvider } from '../../state/mapper-provider-context';
import { RouteDiagram } from './RouteDiagram';

const inputClass =
  'mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none';

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; model: string; latencyMs: number }
  | { status: 'error'; message: string };

export function ProviderSettingsPanel({ compact }: { compact?: boolean }): ReactNode {
  const { settings, updateSettings, setCredentials, config, problems } = useMapperProvider();
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const info = PROVIDERS[config.provider];
  const creds = config.credentials;

  const setCred = (patch: Partial<ProviderCredentials>) => {
    setCredentials(config.provider, { ...creds, ...patch });
    setTest({ status: 'idle' });
  };

  const runTest = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTest({ status: 'running' });
    try {
      const result = await testProviderConnection(config, {}, controller.signal);
      setTest({ status: 'ok', ...result });
    } catch (err) {
      const message = err instanceof ProviderError ? `${err.kind}: ${err.message}` : String(err);
      setTest({ status: 'error', message });
    }
  };

  return (
    <div className="space-y-3">
      <fieldset className="m-0 grid grid-cols-4 gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
        <legend className="sr-only">Provider</legend>
        {PROVIDER_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              updateSettings({ provider: id });
              setTest({ status: 'idle' });
            }}
            className={cx(
              'truncate rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors',
              settings.provider === id
                ? 'bg-violet-500/20 text-violet-200'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
            )}
          >
            {PROVIDERS[id].label}
          </button>
        ))}
      </fieldset>
      <p className="m-0 text-[11px] text-zinc-500">{info.docsHint}</p>

      <div className={cx('grid gap-2', info.needsRegion ? 'grid-cols-[1fr_8rem]' : 'grid-cols-1')}>
        <label className="text-[11px] text-zinc-400">
          Model
          <input
            value={settings.models[config.provider] ?? info.defaultModel}
            onChange={(e) =>
              updateSettings({ models: { ...settings.models, [config.provider]: e.target.value } })
            }
            placeholder={info.modelPlaceholder}
            className={`${inputClass} font-mono`}
          />
        </label>
        {info.needsRegion && (
          <label className="text-[11px] text-zinc-400">
            Region
            <input
              value={settings.regions[config.provider] ?? info.defaultRegion ?? ''}
              onChange={(e) =>
                updateSettings({
                  regions: { ...settings.regions, [config.provider]: e.target.value },
                })
              }
              placeholder="us-east-1"
              className={`${inputClass} font-mono`}
            />
          </label>
        )}
      </div>

      {info.authModes.length > 1 && (
        <div className="flex gap-3 text-[11px] text-zinc-400">
          {info.authModes.map((mode) => (
            <label key={mode} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name={`auth-${config.provider}`}
                checked={config.authMode === mode}
                onChange={() =>
                  updateSettings({ authModes: { ...settings.authModes, [config.provider]: mode } })
                }
                className="accent-violet-400"
              />
              {mode === 'apiKey' ? 'Bedrock API key' : 'AWS access keys (SigV4)'}
            </label>
          ))}
        </div>
      )}

      {config.authMode === 'apiKey' ? (
        <label className="block text-[11px] text-zinc-400">
          {info.keyLabel}
          <input
            type="password"
            autoComplete="off"
            value={creds.apiKey ?? ''}
            onChange={(e) => setCred({ apiKey: e.target.value })}
            placeholder={info.keyPlaceholder}
            className={`${inputClass} font-mono`}
          />
        </label>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-zinc-400">
            Access key id
            <input
              autoComplete="off"
              value={creds.awsAccessKeyId ?? ''}
              onChange={(e) => setCred({ awsAccessKeyId: e.target.value })}
              placeholder="AKIA…"
              className={`${inputClass} font-mono`}
            />
          </label>
          <label className="text-[11px] text-zinc-400">
            Secret access key
            <input
              type="password"
              autoComplete="off"
              value={creds.awsSecretAccessKey ?? ''}
              onChange={(e) => setCred({ awsSecretAccessKey: e.target.value })}
              className={`${inputClass} font-mono`}
            />
          </label>
          <label className="col-span-2 text-[11px] text-zinc-400">
            Session token (optional)
            <input
              type="password"
              autoComplete="off"
              value={creds.awsSessionToken ?? ''}
              onChange={(e) => setCred({ awsSessionToken: e.target.value })}
              className={`${inputClass} font-mono`}
            />
          </label>
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
        <input
          type="checkbox"
          checked={settings.rememberKeys}
          onChange={(e) => updateSettings({ rememberKeys: e.target.checked })}
          className="accent-violet-400"
        />
        Remember keys on this device (localStorage)
      </label>
      {!compact && (
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
          <input
            type="checkbox"
            checked={settings.keepSamples}
            onChange={(e) => updateSettings({ keepSamples: e.target.checked })}
            className="accent-violet-400"
          />
          Keep truncated samples with AI profiles (re-checked for regressions when improving)
        </label>
      )}

      <RouteDiagram config={config} rememberKeys={settings.rememberKeys} compact={compact} />

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={problems.length > 0 || test.status === 'running'}
          onClick={runTest}
          title={problems.join('\n') || 'Send a tiny request to check credentials'}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {test.status === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        <span
          className={cx(
            'min-w-0 truncate text-[11px]',
            test.status === 'ok' && 'text-emerald-400',
            test.status === 'error' && 'text-red-400',
            (test.status === 'idle' || test.status === 'running') && 'text-zinc-500',
          )}
          title={test.status === 'error' ? test.message : undefined}
        >
          {test.status === 'ok' && `Connected · ${test.model} · ${test.latencyMs} ms`}
          {test.status === 'error' && test.message}
          {test.status === 'idle' && problems[0]}
        </span>
      </div>
    </div>
  );
}
