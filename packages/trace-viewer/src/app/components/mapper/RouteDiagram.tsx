import {
  BrowserIcon,
  CloudIcon,
  HardDrivesIcon,
  KeyIcon,
  ProhibitIcon,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { maskSecret, PROVIDERS } from '../../lib/payload-mapper/providers/catalog';
import type { ProviderConfig } from '../../lib/payload-mapper/providers/types';
import { cx } from '../../lib/viewer';

type RouteDiagramProps = {
  config: ProviderConfig;
  rememberKeys: boolean;
  /** Optional line describing what is sent (e.g. sample count / size). */
  payloadSummary?: string;
  compact?: boolean;
};

function Node({
  icon,
  title,
  subtitle,
  tone,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  tone: 'local' | 'remote' | 'muted';
}): ReactNode {
  return (
    <div
      className={cx(
        'flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2',
        tone === 'local' && 'border-sky-500/30 bg-sky-500/5',
        tone === 'remote' && 'border-violet-500/30 bg-violet-500/5',
        tone === 'muted' && 'border-dashed border-zinc-800 bg-transparent opacity-60',
      )}
    >
      <span className="shrink-0 text-zinc-300">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-zinc-100">{title}</span>
        <span className="block truncate font-mono text-[10px] text-zinc-500">{subtitle}</span>
      </span>
    </div>
  );
}

/** Visual explanation of where the API key and payload samples travel. */
export function RouteDiagram({
  config,
  rememberKeys,
  payloadSummary,
  compact,
}: RouteDiagramProps): ReactNode {
  const info = PROVIDERS[config.provider];
  const host = info.endpoint(config.region || info.defaultRegion || '…');
  const credential =
    config.authMode === 'awsKeys'
      ? `SigV4 · ${maskSecret(config.credentials.awsAccessKeyId)}`
      : maskSecret(config.credentials.apiKey);

  return (
    <figure className="m-0 space-y-2" aria-label="Where your key and data go">
      <div className="flex items-stretch gap-2">
        <Node
          icon={<BrowserIcon className="h-4 w-4" weight="duotone" />}
          title="This browser tab"
          subtitle={rememberKeys ? 'key in localStorage' : 'key in memory only'}
          tone="local"
        />
        <div
          className="flex shrink-0 flex-col items-center justify-center px-1 text-[10px] text-zinc-400"
          title={`POST https://${host}\nAuth: ${credential}`}
        >
          <span className="flex items-center gap-1 whitespace-nowrap">
            <KeyIcon className="h-3 w-3 text-amber-300" weight="bold" />
            {credential}
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 80 10"
            className="mt-0.5 h-2.5 w-20 text-violet-400/70"
          >
            <line
              x1="0"
              y1="5"
              x2="72"
              y2="5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <path d="M72 1 L80 5 L72 9 Z" fill="currentColor" />
          </svg>
          <span className="mt-0.5 text-zinc-500">HTTPS · direct</span>
        </div>
        <Node
          icon={<CloudIcon className="h-4 w-4" weight="duotone" />}
          title={info.label}
          subtitle={host}
          tone="remote"
        />
      </div>
      {!compact && (
        <div className="flex items-center gap-2">
          <Node
            icon={<HardDrivesIcon className="h-4 w-4" weight="duotone" />}
            title="trace-viewer server"
            subtitle="127.0.0.1 · not involved"
            tone="muted"
          />
          <span className="flex items-center gap-1 text-[10px] text-zinc-500">
            <ProhibitIcon className="h-3 w-3" weight="bold" />
            never receives your key
          </span>
        </div>
      )}
      <figcaption className="text-[11px] leading-relaxed text-zinc-500">
        The request goes straight from this tab to {info.label}.{' '}
        {rememberKeys
          ? 'Your key is saved in this browser’s localStorage (separate from exported settings).'
          : 'Your key is kept in memory and forgotten when you close or reload the tab.'}
        {payloadSummary ? ` Sent: ${payloadSummary}.` : ''}
      </figcaption>
    </figure>
  );
}
