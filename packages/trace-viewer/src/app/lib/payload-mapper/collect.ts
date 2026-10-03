import type { RunNode } from '../../types';
import {
  buildSampleGroups,
  collectRunRefs,
  DEFAULT_TRUNCATE_LIMITS,
  groupRunRefs,
  planSamples,
  type RunGroup,
  type SampleGroup,
} from './sampling';

export type CollectDeps = {
  getTree: (traceId: string) => Promise<{ root: RunNode } | null>;
  getPayload: (ref: string) => Promise<unknown>;
};

export type CollectProgress =
  | { phase: 'trees'; done: number; total: number }
  | { phase: 'payloads'; done: number; total: number };

export type CollectInput = {
  traceIds: string[];
  deps: CollectDeps;
  perGroup?: number;
  maxGroups?: number;
  /** Refs that must be sampled (e.g. a run the user wants to improve). */
  pinnedRefs?: string[];
  /** Already-loaded trees / payloads to avoid refetching. */
  knownTrees?: Record<string, { root: RunNode }>;
  knownPayloads?: Record<string, unknown>;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: CollectProgress) => void;
};

export type CollectResult = {
  groups: SampleGroup[];
  /** Every group found in the scanned traces (including ones not sampled). */
  allGroups: RunGroup[];
  scannedTraces: number;
  failedPayloads: number;
};

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function collectSampleGroups(input: CollectInput): Promise<CollectResult> {
  const { deps, signal, onProgress } = input;
  const concurrency = input.concurrency ?? 6;

  let treesDone = 0;
  const trees = await mapLimit(
    input.traceIds,
    concurrency,
    async (traceId) => {
      const tree = input.knownTrees?.[traceId] ?? (await deps.getTree(traceId).catch(() => null));
      onProgress?.({ phase: 'trees', done: ++treesDone, total: input.traceIds.length });
      return tree ? { traceId, root: tree.root } : null;
    },
    signal,
  );
  const loaded = trees.filter((t): t is { traceId: string; root: RunNode } => t !== null);

  const allGroups = groupRunRefs(collectRunRefs(loaded));
  const planned = planSamples(allGroups, {
    perGroup: input.perGroup ?? 3,
    maxGroups: input.maxGroups ?? 40,
    pinned: input.pinnedRefs,
  });

  const refs = [...new Set(planned.flatMap((g) => g.refs.map((r) => r.ref)))];
  const payloads: Record<string, unknown> = {};
  let failedPayloads = 0;
  let payloadsDone = 0;
  await mapLimit(
    refs,
    concurrency,
    async (ref) => {
      const known = input.knownPayloads?.[ref];
      if (known !== undefined) payloads[ref] = known;
      else {
        try {
          payloads[ref] = await deps.getPayload(ref);
        } catch {
          failedPayloads++;
        }
      }
      onProgress?.({ phase: 'payloads', done: ++payloadsDone, total: refs.length });
    },
    signal,
  );

  return {
    groups: buildSampleGroups(planned, payloads, allGroups, DEFAULT_TRUNCATE_LIMITS),
    allGroups,
    scannedTraces: loaded.length,
    failedPayloads,
  };
}
