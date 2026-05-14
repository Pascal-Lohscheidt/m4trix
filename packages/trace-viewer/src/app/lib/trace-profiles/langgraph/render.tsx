import type { ReactNode } from 'react';
import { PayloadSection } from '../../../components/PayloadSection';
import type { RunNode } from '../../../types';
import type { ProfileRenderProps } from '../types';

function JsonBlock({ value }: { value: unknown }): ReactNode {
  return (
    <pre className="m-0 max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const LANGGRAPH_META_KEYS = [
  'langgraph_node',
  'graph_node',
  'checkpoint_ns',
  'thread_id',
  'langgraph_step',
  'langgraph_path',
  'langgraph_triggers',
] as const;

function pickLanggraphMeta(meta: Record<string, string | number | boolean>): [string, string][] {
  const entries: [string, string][] = [];
  for (const key of LANGGRAPH_META_KEYS) {
    if (key in meta && meta[key] != null && meta[key] !== '') {
      entries.push([key, String(meta[key])]);
    }
  }
  return entries;
}

export function renderLanggraphMetadata({ run }: ProfileRenderProps): ReactNode {
  if (!run.metadata || Object.keys(run.metadata).length === 0) return null;
  const picked = pickLanggraphMeta(run.metadata);
  if (picked.length === 0) {
    return (
      <div className="mt-3">
        <div className="mb-1.5 font-semibold">Metadata</div>
        <JsonBlock value={run.metadata} />
      </div>
    );
  }
  return (
    <div className="mt-3">
      <div className="mb-1.5 font-semibold">Metadata</div>
      <dl className="mb-2 grid gap-1 rounded-lg border border-violet-500/20 bg-violet-500/5 p-2 text-xs">
        {picked.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(0,7rem)_1fr] gap-2">
            <dt className="truncate font-mono text-violet-300/90">{k}</dt>
            <dd className="break-all text-zinc-200">{v}</dd>
          </div>
        ))}
      </dl>
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-300">
          Raw metadata JSON
        </summary>
        <div className="mt-2">
          <JsonBlock value={run.metadata} />
        </div>
      </details>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function messageRowKey(msg: unknown, index: number): string {
  const o = asRecord(msg);
  const id = o && typeof o.id === 'string' ? o.id : '';
  if (id) return id;
  try {
    return `m-${index}-${JSON.stringify(msg).slice(0, 120)}`;
  } catch {
    return `m-${index}`;
  }
}

function renderMessagesSummary(messages: unknown[]): ReactNode {
  return (
    <ul className="m-0 max-h-64 list-none space-y-2 overflow-auto p-0 text-xs">
      {messages.slice(0, 40).map((msg, i) => {
        const o = asRecord(msg);
        const type = (typeof o?.type === 'string' && o.type) || 'message';
        const content = o?.content;
        let preview = '';
        if (typeof content === 'string') preview = content;
        else if (Array.isArray(content))
          preview = content.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join(' ');
        else if (content != null) preview = JSON.stringify(content);
        preview = preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
        return (
          <li
            key={messageRowKey(msg, i)}
            className="rounded-md border border-zinc-800 bg-zinc-950/80 px-2 py-1.5 font-mono text-[11px] text-zinc-300"
          >
            <span className="text-amber-300/90">{type}</span>
            {preview ? (
              <span className="mt-1 block whitespace-pre-wrap text-zinc-400">{preview}</span>
            ) : null}
          </li>
        );
      })}
      {messages.length > 40 ? (
        <li className="text-zinc-500">… {messages.length - 40} more messages</li>
      ) : null}
    </ul>
  );
}

function renderPayloadSummary(data: unknown): ReactNode {
  const o = asRecord(data);
  if (o && Array.isArray(o.messages) && o.messages.length > 0) {
    return (
      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Messages
        </div>
        {renderMessagesSummary(o.messages as unknown[])}
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-300">Raw JSON</summary>
          <div className="mt-2">
            <JsonBlock value={data} />
          </div>
        </details>
      </div>
    );
  }
  return <JsonBlock value={data} />;
}

function payloadSection(
  label: string,
  run: RunNode,
  refKey: 'inputRef' | 'outputRef',
  payloadCache: Record<string, unknown>,
  payloadLoading: string | null,
  onLoadPayload: (ref: string) => void,
): ReactNode {
  const refId = run[refKey];
  return (
    <PayloadSection
      label={label}
      refId={refId}
      payloadCache={payloadCache}
      loadingRef={payloadLoading}
      onLoad={onLoadPayload}
      renderLoaded={renderPayloadSummary}
    />
  );
}

export function renderLanggraphInput(props: ProfileRenderProps): ReactNode {
  return payloadSection(
    'Input',
    props.run,
    'inputRef',
    props.payloadCache,
    props.payloadLoading,
    props.onLoadPayload,
  );
}

export function renderLanggraphOutput(props: ProfileRenderProps): ReactNode {
  return payloadSection(
    'Output',
    props.run,
    'outputRef',
    props.payloadCache,
    props.payloadLoading,
    props.onLoadPayload,
  );
}
