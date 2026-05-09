import type { RunNode } from '../types';
import { buildMatchContext, nodeMatchesHide, type FilterGroup } from './filter-groups';

export type RunTreeDisplayFilterResult = {
  /** Root after hide rules (promotion / bypass). `null` if everything was pruned. */
  root: RunNode | null;
  /** Depth in the original trace tree, used for depth conditions after reshaping. */
  depthByRunId: ReadonlyMap<string, number>;
  /**
   * Run ids that matched a hide group but remain in the tree as branch nodes because
   * several visible descendants would otherwise be lost.
   */
  hideBypassRunIds: ReadonlySet<string>;
};

function collectOriginalDepths(node: RunNode, depth: number, into: Map<string, number>): void {
  into.set(node.runId, depth);
  for (const child of node.children) {
    collectOriginalDepths(child, depth + 1, into);
  }
}

function shallowClone(node: RunNode, children: RunNode[]): RunNode {
  return { ...node, children };
}

function nodeMatchesHideAtOriginalDepth(
  node: RunNode,
  depthByRunId: ReadonlyMap<string, number>,
  groups: FilterGroup[],
): boolean {
  const depth = depthByRunId.get(node.runId) ?? 0;
  return nodeMatchesHide(groups, buildMatchContext(node, depth));
}

/**
 * Applies hide-type filter groups to the run tree:
 * - Depth conditions always use the depth from the **original** trace, not UI indentation.
 * - If a node matches hide and has **no** surviving children after recursion, it is dropped.
 * - If it matches hide and has **exactly one** surviving child, the hidden parent is **omitted**
 *   and that child is promoted (so visible spans are not lost only because an ancestor matched hide).
 * - If it matches hide and has **multiple** surviving children, the parent row is **kept**
 *   (bypass) so those branches stay grouped; `hideBypassRunIds` tells the UI not to drop that row.
 *
 * Collapse-only groups do not change structure here; they are still handled in `RunTree`.
 */
export function applyRunTreeDisplayFilter(
  root: RunNode,
  groups: FilterGroup[],
): RunTreeDisplayFilterResult {
  const depthByRunId = new Map<string, number>();
  collectOriginalDepths(root, 0, depthByRunId);

  const hideActive = groups.some((g) => g.hideEnabled);
  if (!hideActive) {
    return { root, depthByRunId, hideBypassRunIds: new Set<string>() };
  }

  const hideBypassRunIds = new Set<string>();

  const visit = (node: RunNode): RunNode | null => {
    const filteredChildren = node.children
      .map((child) => visit(child))
      .filter((child): child is RunNode => child !== null);

    if (!nodeMatchesHideAtOriginalDepth(node, depthByRunId, groups)) {
      return shallowClone(node, filteredChildren);
    }

    if (filteredChildren.length === 0) return null;
    if (filteredChildren.length === 1) return filteredChildren[0];
    hideBypassRunIds.add(node.runId);
    return shallowClone(node, filteredChildren);
  };

  const nextRoot = visit(root);
  return {
    root: nextRoot,
    depthByRunId,
    hideBypassRunIds,
  };
}
