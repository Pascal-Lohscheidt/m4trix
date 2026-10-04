import { formatRunLabel, type RunTreeNode } from './trace-access';

/** LangGraph plumbing spans that rarely matter when debugging. */
export const DEFAULT_HIDE_PATTERN = '^(ChannelWrite<.*>|Branch<.*>|__start__|__end__)$';

export type TreeOutlineOptions = {
  /** Regex against run names; matching runs are skipped and their children promoted. */
  hide?: RegExp | null;
  maxDepth?: number;
  maxNodes?: number;
};

export type TreeOutline = {
  text: string;
  shown: number;
  hidden: number;
  /** Runs below `maxDepth` or past `maxNodes`. */
  omitted: number;
};

/**
 * Renders runs as an indented outline. Error runs are never hidden, so a hide pattern
 * cannot mask a failure.
 */
export function renderTreeOutline(
  roots: RunTreeNode[],
  options: TreeOutlineOptions = {},
): TreeOutline {
  const maxNodes = options.maxNodes ?? 200;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  let shown = 0;
  let hidden = 0;
  let omitted = 0;

  const countSubtree = (node: RunTreeNode): number =>
    1 + node.children.reduce((sum, child) => sum + countSubtree(child), 0);

  const visit = (node: RunTreeNode, level: number): void => {
    const isHidden = node.status !== 'error' && options.hide?.test(node.name) === true;
    if (isHidden) {
      hidden += 1;
      for (const child of node.children) visit(child, level);
      return;
    }
    if (shown >= maxNodes) {
      omitted += countSubtree(node);
      return;
    }
    shown += 1;
    lines.push(`${'  '.repeat(level)}${formatRunLabel(node)}`);
    if (level + 1 > maxDepth) {
      const below = node.children.reduce((sum, child) => sum + countSubtree(child), 0);
      if (below > 0) {
        lines.push(`${'  '.repeat(level + 1)}… ${below} runs below max depth`);
        omitted += below;
      }
      return;
    }
    for (const child of node.children) visit(child, level + 1);
  };

  for (const root of roots) visit(root, 0);
  if (shown >= maxNodes && omitted > 0) {
    lines.push(`… output capped at ${maxNodes} runs; use focusRunId or maxDepth to narrow.`);
  }
  return { text: lines.join('\n'), shown, hidden, omitted };
}
