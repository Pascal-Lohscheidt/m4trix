import {
  BrainIcon,
  CaretRightIcon,
  CoinsIcon,
  CurrencyCircleDollarIcon,
  LinkSimpleIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useRef, useState } from 'react';
import { buildMatchContext, nodeDisplayEffect } from '../lib/filter-groups';
import {
  formatSubtreeCostSuffix,
  formatSubtreeRollupTitle,
  formatSubtreeTokenCount,
  subtreeRollupTotalTokens,
  type RunSubtreeRollup,
} from '../lib/trace-profiles/langgraph/aggregates';
import { useReveal } from '../lib/motion';
import { cx, statusDotClass, statusTextClass } from '../lib/viewer';
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
  const costSuffix = formatSubtreeCostSuffix(rollup);
  const showCostOnly = !tokenCount && costSuffix != null;
  if (!tokenCount && !showCostOnly) return null;

  const badgeClass = cx(
    'ml-2 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]',
    complete
      ? 'border-violet-300/20 bg-violet-400/10 text-violet-200'
      : 'border-violet-300/10 bg-violet-400/5 text-violet-300/80',
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
          {costSuffix ? <span className="text-violet-300/80">{costSuffix}</span> : null}
        </>
      ) : (
        <>
          <CurrencyCircleDollarIcon aria-hidden="true" weight="bold" className={iconClass} />
          <span>{costSuffix}</span>
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
      <span className="mr-2 inline-flex items-center gap-1 rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-200 ring-1 ring-sky-300/20 ring-inset">
        <WrenchIcon aria-hidden="true" weight="bold" className={iconClassName} />
        {type}
      </span>
    );
  }

  if (normalizedType.includes('chain')) {
    return (
      <span className="mr-2 inline-flex items-center gap-1 rounded-full bg-violet-400/10 px-2 py-0.5 text-[11px] font-medium text-violet-200 ring-1 ring-violet-300/20 ring-inset">
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
      <span className="mr-2 inline-flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-200 ring-1 ring-amber-300/20 ring-inset">
        <BrainIcon aria-hidden="true" weight="bold" className={iconClassName} />
        {type}
      </span>
    );
  }

  return <span className="mr-2 text-[11px] text-zinc-500">{type}</span>;
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
  const childrenRef = useRef<HTMLDivElement>(null);
  const expandedByUser = useRef(false);
  // Only animate children the user just expanded, not the initial render of the whole tree.
  useReveal(childrenRef, showChildren, {
    distance: 6,
    staggerMs: 18,
    selector: ':scope > *',
    enabled: expandedByUser.current,
  });

  if (hidden && !bypassHide) return null;

  return (
    <div key={node.runId} className="w-max min-w-full">
      <div
        className={cx(
          'mb-0.5 flex w-full items-center rounded-xl text-[13px] whitespace-nowrap transition-[background-color,box-shadow] duration-200',
          selected
            ? 'bg-violet-400/[0.14] text-violet-50 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08),inset_0_0_0_1px_rgb(196_181_253_/_0.16)]'
            : 'text-zinc-200 hover:bg-white/[0.05]',
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
              expandedByUser.current = true;
              setExpanded((current) => !current);
            }}
            className={cx(
              'ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100',
              forceCollapse && 'cursor-not-allowed opacity-50',
            )}
          >
            <CaretRightIcon
              aria-hidden="true"
              weight="bold"
              className={cx(
                'h-3 w-3 transition-transform duration-300 ease-[var(--ease-glass)]',
                chevronExpanded && 'rotate-90',
              )}
            />
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
          <span
            title={node.status}
            className={cx('ml-2 h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass(node.status))}
          />
          <span className="sr-only">{node.status}</span>
          {node.status !== 'success' && (
            <span className={cx('ml-1.5 text-xs', statusTextClass(node.status))}>
              {node.status}
            </span>
          )}
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
        <div ref={childrenRef} className="ml-[18px] border-l border-white/[0.07] pl-2.5">
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
