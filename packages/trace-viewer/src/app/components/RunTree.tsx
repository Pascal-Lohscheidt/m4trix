import { Brain, LinkSimple, Wrench } from '@phosphor-icons/react';
import { useState } from 'react';
import { cx, statusTextClass } from '../lib/viewer';
import type { RunNode } from '../types';

type RunTreeProps = {
  node: RunNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
};

function runTypeBadge(type: string): React.ReactNode {
  const normalizedType = type.toLowerCase().replaceAll(/[\s_-]/g, '');
  const iconClassName = 'h-3.5 w-3.5';

  if (normalizedType.includes('tool')) {
    return (
      <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-xs text-sky-300">
        <Wrench aria-hidden="true" weight="bold" className={iconClassName} />
        {type}
      </span>
    );
  }

  if (normalizedType.includes('chain')) {
    return (
      <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-xs text-violet-300">
        <LinkSimple aria-hidden="true" weight="bold" className={iconClassName} />
        {type}
      </span>
    );
  }

  if (
    normalizedType.includes('llm') ||
    normalizedType.includes('ai') ||
    normalizedType.includes('model')
  ) {
    return (
      <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300">
        <Brain aria-hidden="true" weight="bold" className={iconClassName} />
        {type}
      </span>
    );
  }

  return <span className="mr-2 text-zinc-400">{type}</span>;
}

export function RunTree(props: RunTreeProps): React.ReactNode {
  const { node, selectedId, onSelect } = props;
  const selected = node.runId === selectedId;
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);

  return (
    <div key={node.runId} className="w-max min-w-full">
      <div
        className={cx(
          'mb-1 flex w-full items-center whitespace-nowrap rounded-md border text-[13px] text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800',
          selected
            ? 'border-amber-400 bg-zinc-800 shadow-[0_0_0_1px_rgba(251,191,36,0.15)]'
            : 'border-zinc-700 bg-zinc-900',
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="ml-1 inline-block h-6 w-6 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.runId)}
          className="flex flex-1 items-center px-2.5 py-1.5 text-left"
        >
          {runTypeBadge(node.type)}
          <span>{node.name}</span>
          <span className={cx('ml-2 text-xs', statusTextClass(node.status))}>{node.status}</span>
          {hasChildren && !expanded && (
            <span className="ml-2 text-xs text-zinc-500">
              {node.children.length} {node.children.length === 1 ? 'child' : 'children'}
            </span>
          )}
        </button>
      </div>
      {hasChildren && expanded && (
        <div className="ml-4 border-l border-zinc-800 pl-3">
          {node.children.map((child) => (
            <RunTree key={child.runId} node={child} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
