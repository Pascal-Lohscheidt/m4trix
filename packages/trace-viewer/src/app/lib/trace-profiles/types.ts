import type { RunNode, TraceRow } from '../../types';

export type TraceProfileId = 'raw' | 'langgraph';

export type ProfileRenderProps = {
  run: RunNode;
  payloadCache: Record<string, unknown>;
  payloadLoading: string | null;
  onLoadPayload: (ref: string) => void;
};

export type AggregateContext = {
  trace: TraceRow;
  root: RunNode;
  payloadCache: Record<string, unknown>;
  /** True when every `inputRef` / `outputRef` on the tree exists in `payloadCache`. */
  fullTracePayloadsLoaded: boolean;
};

export type ProfileAggregates = {
  /** When aggregates need the full trace loaded first. */
  pendingReason?: 'missing_trace_payloads';
  cards: { id: string; label: string; value: string }[];
};

export function collectPayloadRefsFromTree(root: RunNode): string[] {
  const refs: string[] = [];
  const visit = (node: RunNode) => {
    if (node.inputRef) refs.push(node.inputRef);
    if (node.outputRef) refs.push(node.outputRef);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return [...new Set(refs)];
}

export function isFullTracePayloadsLoaded(
  root: RunNode,
  payloadCache: Record<string, unknown>,
): boolean {
  const refs = collectPayloadRefsFromTree(root);
  return refs.every((ref) => payloadCache[ref] !== undefined);
}
