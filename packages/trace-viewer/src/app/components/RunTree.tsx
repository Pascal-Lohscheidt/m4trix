import {
  BrainIcon,
  CoinsIcon,
  CurrencyCircleDollarIcon,
  LinkSimpleIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import { buildMatchContext, nodeDisplayEffect } from '../lib/filter-groups';
import {
  formatSubtreeRollupTitle,
  formatSubtreeTokenCount,
  subtreeRollupTotalTokens,
  type RunSubtreeRollup,
} from '../lib/trace-profiles/langgraph/aggregates';
import { cx, statusTextClass } from '../lib/viewer';
import { useFilterGroups } from '../state/filter-groups-context';
import type { RunNode } from '../types';

type RunTreeProps = {
  node: RunNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Original trace depth per run id (after display filter reshapes the tree). */
  depthByRunId?: ReadonlyMap<string, number>;
  /** Nodes that matched hide but are kept as branch points (multiple visible children). */
  hideBypassRunIds?: ReadonlySet<string>;
  /** LangGraph profile: subtree token/cost totals keyed by run id. */
  subtreeRollupsByRunId?: ReadonlyMap<string, RunSubtreeRollup>;
  /** When false, rollups may be incomplete (not all payloads loaded). */
  subtreeRollupsComplete?: boolean;
  depth?: number;
};

function SubtreeRollupBadge({
  rollup,
  complete,
}: {
  rollup: RunSubtreeRollup;
  complete: boolean;
}): ReactNode {
  const tokenCount = formatSubtreeTokenCount(rollup);
  const showCostOnly = !tokenCount && rollup.costUsd > 0;
  if (!tokenCount && !showCostOnly) return null;

  const badgeClass = cx(
    'ml-2 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]',
    complete
      ? 'border-violet-400/30 bg-violet-400/10 text-violet-200'
      : 'border-violet-400/20 bg-violet-400/5 text-violet-300/80',
  );
  const iconClass = 'h-3 w-3 shrink-0';

  return (
    <span
      title={formatSubtreeRollupTitle(rollup) + (complete ? '' : ' (partial — load all payloads)')}
      className={badgeClass}
    >
      {tokenCount ? (
        <>
          <CoinsIcon aria-hidden="true" weight="bold" className={iconClass} />
          <span className="sr-only">{subtreeRollupTotalTokens(rollup)} tokens</span>
          <span>{tokenCount}</span>
        </>
      ) : (
        <>
          <CurrencyCircleDollarIcon aria-hidden="true" weight="bold" className={iconClass} />
          <span>${rollup.costUsd.toFixed(4)}</span>
        </>
      )}
      {!complete ? <span aria-hidden="true">*</span> : null}
    </span>
  );
}

function runTypeBadge(type: string): ReactNode {
  const normalizedType = type.toLowerCase().replaceAll(/[\s_-]/g, '');
  const iconClassName = 'h-3.5 w-3.5';

  if (normalizedType.includes('tool')) {
    return (
      <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-xs text-sky-300">
        <WrenchIcon aria-hidden="true" weight="bold" className={iconClassName} />
        {type}
      </span>
    );
  }

  if (normalizedType.includes('chain')) {
    return (
      <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-xs text-violet-300">
        <LinkSimpleIcon aria-hidden="true" weight="bold" className={iconClassName} />
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
        <BrainIcon aria-hidden="true" weight="bold" className={iconClassName} />
        {type}
      </span>
    );
  }

  return <span className="mr-2 text-zinc-400">{type}</span>;
}

export function RunTree(props: RunTreeProps): ReactNode {
  const {
    node,
    selectedId,
    onSelect,
    depthByRunId,
    hideBypassRunIds,
    subtreeRollupsByRunId,
    subtreeRollupsComplete = true,
    depth = 0,
  } = props;
  const { filterGroups } = useFilterGroups();
  const filterDepth = depthByRunId?.get(node.runId) ?? depth;
  const ctx = buildMatchContext(node, filterDepth);
  const { hidden, forceCollapse } = nodeDisplayEffect(filterGroups, ctx);
  const bypassHide = hideBypassRunIds?.has(node.runId) ?? false;
  const subtreeRollup = subtreeRollupsByRunId?.get(node.runId);

  const selected = node.runId === selectedId;
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);
  const showChildren = hasChildren && expanded && !forceCollapse;
  const chevronExpanded = expanded && !forceCollapse;

  if (hidden && !bypassHide) return null;

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
            disabled={forceCollapse}
            title={forceCollapse ? 'Collapsed by filter group' : undefined}
            aria-label={chevronExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-expanded={chevronExpanded}
            onClick={() => {
              if (forceCollapse) return;
              setExpanded((current) => !current);
            }}
            className={cx(
              'ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100',
              forceCollapse && 'cursor-not-allowed opacity-50',
            )}
          >
            {chevronExpanded ? '▾' : '▸'}
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
          {subtreeRollup?.hasUsage ? (
            <SubtreeRollupBadge rollup={subtreeRollup} complete={subtreeRollupsComplete} />
          ) : null}
          {hasChildren && (!expanded || forceCollapse) ? (
            <span className="ml-2 text-xs text-zinc-500">
              {forceCollapse
                ? `${node.children.length} hidden by filter`
                : `${node.children.length} ${node.children.length === 1 ? 'child' : 'children'}`}
            </span>
          ) : null}
        </button>
      </div>
      {showChildren && (
        <div className="ml-4 border-l border-zinc-800 pl-3">
          {node.children.map((child) => (
            <RunTree
              key={child.runId}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              depthByRunId={depthByRunId}
              hideBypassRunIds={hideBypassRunIds}
              subtreeRollupsByRunId={subtreeRollupsByRunId}
              subtreeRollupsComplete={subtreeRollupsComplete}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
