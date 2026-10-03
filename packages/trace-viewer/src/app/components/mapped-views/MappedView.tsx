import { WarningIcon, WrenchIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type {
  ResolvedContentPart,
  ResolvedMessage,
  ResolvedToolCall,
  ResolvedView,
  RoleClass,
} from '../../lib/payload-mapper/extract';
import { cx } from '../../lib/viewer';
import { JsonBlock } from './JsonBlock';
import { Markdown } from './Markdown';

const ROLE_STYLES: Record<RoleClass, { card: string; badge: string }> = {
  user: { card: 'border-sky-500/25 bg-sky-500/5', badge: 'bg-sky-500/15 text-sky-200' },
  assistant: {
    card: 'border-emerald-500/25 bg-emerald-500/5',
    badge: 'bg-emerald-500/15 text-emerald-200',
  },
  system: { card: 'border-zinc-700 bg-zinc-900/60', badge: 'bg-zinc-700/60 text-zinc-300' },
  tool: { card: 'border-violet-500/25 bg-violet-500/5', badge: 'bg-violet-500/15 text-violet-200' },
  other: { card: 'border-zinc-800 bg-zinc-950/60', badge: 'bg-zinc-800 text-zinc-300' },
};

function Section({ title, children }: { title?: string; children: ReactNode }): ReactNode {
  if (!title) return children;
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</div>
      {children}
    </div>
  );
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function ScalarValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="text-zinc-600">—</span>;
  if (typeof value === 'string') {
    return <span className="whitespace-pre-wrap break-words text-zinc-200">{value}</span>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono text-amber-200">{String(value)}</span>;
  }
  return <JsonBlock value={value} className="max-h-48 p-1.5 text-[11px]" />;
}

function KeyValueGrid({ entries }: { entries: { label: string; value: unknown }[] }): ReactNode {
  return (
    <dl className="m-0 grid gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
      {entries.map((entry) => (
        <div key={entry.label} className="grid grid-cols-[minmax(0,8rem)_1fr] gap-2">
          <dt className="truncate font-mono text-zinc-500" title={entry.label}>
            {entry.label}
          </dt>
          <dd className="m-0 min-w-0">
            <ScalarValue value={entry.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ToolArgs({ args }: { args: unknown }): ReactNode {
  if (args === undefined || args === null) return null;
  if (typeof args === 'object' && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    if (entries.length === 0)
      return <span className="text-[11px] text-zinc-600">no arguments</span>;
    if (entries.length <= 12 && entries.every(([, v]) => isScalar(v) || typeof v === 'object')) {
      return <KeyValueGrid entries={entries.map(([label, value]) => ({ label, value }))} />;
    }
  }
  if (typeof args === 'string') return <Markdown source={args} />;
  return <JsonBlock value={args} />;
}

export function ToolCallCard({ call }: { call: ResolvedToolCall }): ReactNode {
  return (
    <div className="space-y-1.5 rounded-lg border border-violet-500/30 bg-violet-500/5 p-2">
      <div className="flex items-center gap-1.5 text-xs">
        <WrenchIcon aria-hidden="true" className="h-3.5 w-3.5 text-violet-300" weight="bold" />
        <span className="font-mono font-semibold text-violet-200">{call.name ?? 'tool call'}</span>
        {call.id && <code className="ml-auto truncate text-[10px] text-zinc-500">{call.id}</code>}
      </div>
      <ToolArgs args={call.args} />
    </div>
  );
}

export function ContentParts({ parts }: { parts: ResolvedContentPart[] }): ReactNode {
  if (parts.length === 0) return null;
  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        const key = `${i}-${part.type}`;
        switch (part.type) {
          case 'text':
            return <Markdown key={key} source={part.text} />;
          case 'reasoning':
            return (
              <details
                key={key}
                className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs"
              >
                <summary className="cursor-pointer text-zinc-400">Reasoning</summary>
                <div className="mt-1 whitespace-pre-wrap italic text-zinc-400">{part.text}</div>
              </details>
            );
          case 'toolCall':
            return <ToolCallCard key={key} call={part.call} />;
          case 'toolResult':
            return (
              <div
                key={key}
                className={cx(
                  'space-y-1.5 rounded-lg border p-2',
                  part.isError
                    ? 'border-red-500/30 bg-red-500/5'
                    : 'border-zinc-800 bg-zinc-950/60',
                )}
              >
                <div className="text-[11px] text-zinc-500">
                  Tool result{part.toolCallId ? ` · ${part.toolCallId}` : ''}
                  {part.isError && <span className="ml-1 text-red-400">error</span>}
                </div>
                <ContentParts parts={part.parts} />
              </div>
            );
          case 'image':
            return (
              <span
                key={key}
                className="inline-block rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-500"
              >
                [{part.label}]
              </span>
            );
          default:
            return <JsonBlock key={key} value={part.value} />;
        }
      })}
    </div>
  );
}

function firstLine(message: ResolvedMessage): string {
  const text = message.parts.find((p) => p.type === 'text');
  if (!text || text.type !== 'text') return '';
  const line = text.text.trim().split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function MessageCard({ message }: { message: ResolvedMessage }): ReactNode {
  const style = ROLE_STYLES[message.roleClass];
  const header = (
    <span className="flex min-w-0 items-center gap-2 text-xs">
      <span className={cx('rounded px-1.5 py-0.5 font-medium', style.badge)}>{message.role}</span>
      {message.name && <span className="truncate font-mono text-zinc-400">{message.name}</span>}
      {message.toolCallId && (
        <code className="truncate text-[10px] text-zinc-500">↳ {message.toolCallId}</code>
      )}
    </span>
  );
  const body = (
    <div className="space-y-2">
      <ContentParts parts={message.parts} />
      {message.toolCalls.map((call, i) => (
        <ToolCallCard key={call.id ?? `${i}-${call.name}`} call={call} />
      ))}
    </div>
  );
  const isEmpty = message.parts.length === 0 && message.toolCalls.length === 0;

  return (
    <li className={cx('rounded-lg border p-2', style.card)}>
      {message.collapsed ? (
        <details>
          <summary className="flex cursor-pointer items-center gap-2">
            {header}
            <span className="truncate text-[11px] text-zinc-500">{firstLine(message)}</span>
          </summary>
          <div className="mt-2">{body}</div>
        </details>
      ) : (
        <>
          {header}
          {isEmpty ? (
            <div className="mt-1 text-[11px] text-zinc-600">empty</div>
          ) : (
            <div className="mt-2">{body}</div>
          )}
        </>
      )}
    </li>
  );
}

export function MappedView({ view }: { view: ResolvedView }): ReactNode {
  switch (view.kind) {
    case 'messages':
      return (
        <Section title={view.title}>
          <ul className="m-0 list-none space-y-2 p-0">
            {view.messages.map((message, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: messages are positional
              <MessageCard key={i} message={message} />
            ))}
          </ul>
          {view.totalCount > view.messages.length && (
            <div className="mt-2 text-xs text-zinc-500">
              … {view.totalCount - view.messages.length} more messages
            </div>
          )}
        </Section>
      );
    case 'toolCall':
      return (
        <Section title={view.title}>
          <ToolCallCard call={view.call} />
        </Section>
      );
    case 'toolResult': {
      const isError = view.status != null && /err|fail/i.test(view.status);
      return (
        <Section title={view.title}>
          <div
            className={cx(
              'space-y-2 rounded-lg border p-2',
              isError ? 'border-red-500/30 bg-red-500/5' : 'border-violet-500/25 bg-violet-500/5',
            )}
          >
            {(view.name || view.status) && (
              <div className="flex items-center gap-2 text-xs">
                {view.name && (
                  <span className="font-mono font-semibold text-violet-200">{view.name}</span>
                )}
                {view.status && (
                  <span
                    className={cx(
                      'rounded px-1.5 py-0.5',
                      isError ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300',
                    )}
                  >
                    {view.status}
                  </span>
                )}
              </div>
            )}
            {view.parts && <ContentParts parts={view.parts} />}
            {view.body && <MappedView view={view.body} />}
          </div>
        </Section>
      );
    }
    case 'keyValue':
      return (
        <Section title={view.title}>
          <KeyValueGrid entries={view.entries} />
        </Section>
      );
    case 'markdown':
      return (
        <Section title={view.title}>
          <Markdown source={view.value} />
        </Section>
      );
    case 'text':
      return (
        <Section title={view.title}>
          <div className="whitespace-pre-wrap break-words text-[13px] text-zinc-300">
            {view.value}
          </div>
        </Section>
      );
    case 'code':
      return (
        <Section title={view.title}>
          <div className="relative">
            {view.language && (
              <span className="absolute right-2 top-1.5 text-[10px] uppercase text-zinc-600">
                {view.language}
              </span>
            )}
            <JsonBlock value={view.value} className="font-mono" />
          </div>
        </Section>
      );
    case 'table':
      return (
        <Section title={view.title}>
          <div className="max-h-96 overflow-auto rounded-lg border border-zinc-800">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-zinc-900">
                <tr>
                  {view.columns.map((col) => (
                    <th
                      key={col}
                      className="border-b border-zinc-800 px-2 py-1 font-medium text-zinc-400"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                  <tr key={i} className="odd:bg-zinc-950/40">
                    {row.map((cell, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                      <td key={j} className="border-b border-zinc-900 px-2 py-1 align-top">
                        <ScalarValue value={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.totalCount > view.rows.length && (
            <div className="mt-1 text-xs text-zinc-500">
              … {view.totalCount - view.rows.length} more rows
            </div>
          )}
        </Section>
      );
    case 'json':
      return (
        <Section title={view.title}>
          <JsonBlock value={view.value} />
        </Section>
      );
    case 'stack':
      return (
        <Section title={view.title}>
          <div className="space-y-3">
            {view.children.map((child, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: children are positional
              <MappedView key={i} view={child} />
            ))}
          </div>
        </Section>
      );
    case 'fallback':
      return (
        <Section title={view.title}>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-[11px] text-amber-400/80">
              <WarningIcon aria-hidden="true" className="h-3 w-3" weight="bold" />
              {view.reason}
            </div>
            <JsonBlock value={view.value} />
          </div>
        </Section>
      );
  }
}
