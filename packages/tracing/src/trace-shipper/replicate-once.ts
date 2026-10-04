import { createReadStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { PayloadStoreAdapter, Trace, TraceRun } from '../types.js';
import { removeShippedTraces } from './cleanup.js';
import { collectPayloadRefs, payloadRefsReplicated, readRunsFile } from './collect-refs.js';
import { listPending } from './list-pending.js';
import { toRef } from './paths.js';
import { loadShipperState, saveShipperState } from './shipper-state.js';
import type {
  PayloadShipWorkItem,
  ReplicateOnceResult,
  ShipFailure,
  ShipperState,
  ShipWorkItem,
  StructureRunsShipWorkItem,
  StructureTraceShipWorkItem,
  TraceShipperDeps,
} from './types.js';

type PutStream = NonNullable<PayloadStoreAdapter['putStream']>;

/**
 * One replication pass. A failing item is recorded in `failures` and left pending for the next
 * pass; it never stops the other items. Annotations are not shipped: they are owned by the
 * destination store, and shipping local copies would overwrite review edits made there.
 */
export async function replicateOnce(deps: TraceShipperDeps): Promise<ReplicateOnceResult> {
  const putStream = deps.payloadDest.putStream?.bind(deps.payloadDest);
  if (!putStream) {
    throw new Error('Destination payload adapter does not support putStream');
  }

  const state = await loadShipperState(deps.root);
  const pending = await listPending(deps.root, state);
  const failures: ShipFailure[] = [];

  let uploadedPayloads = 0;
  let uploadedStructure = 0;
  let removedTraces = 0;

  try {
    for (const item of pending.payloads) {
      if (item.kind !== 'payload') continue;
      if (await attempt(item.ref, failures, () => shipPayload(item, putStream))) {
        uploadedPayloads += 1;
      }
    }

    for (const item of sortStructureItems(pending.structure)) {
      if (item.kind === 'payload') continue;
      const shipped = await attempt(item.ref, failures, () =>
        item.kind === 'structure-runs' ? shipRuns(deps, item) : shipTrace(deps, item, state),
      );
      if (shipped) {
        state.structure[item.ref] = item.mtimeMs;
        uploadedStructure += 1;
      }
    }

    if (deps.retention) {
      const cleanup = await removeShippedTraces(deps.root, state, deps.retention);
      removedTraces = cleanup.removed.length;
      failures.push(...cleanup.failures);
    }
  } finally {
    await saveShipperState(deps.root, state);
  }

  const after = await listPending(deps.root, state);

  return {
    uploadedPayloads,
    uploadedStructure,
    pendingPayloads: after.payloads.length,
    pendingStructure: after.structure.length,
    oldestPendingMs: after.oldestPendingMs,
    removedTraces,
    failures,
  };
}

/** Runs `ship`; returns whether it shipped, recording a thrown error as a failure. */
async function attempt(
  ref: string,
  failures: ShipFailure[],
  ship: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await ship();
  } catch (error) {
    failures.push({ ref, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function shipPayload(item: PayloadShipWorkItem, putStream: PutStream): Promise<boolean> {
  const stream = createReadStream(item.localPath);
  async function* streamBody(): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk as Uint8Array;
    }
  }

  try {
    await putStream(item.ref, streamBody());
  } finally {
    stream.destroy();
  }
  await unlink(item.localPath);
  return true;
}

async function shipRuns(deps: TraceShipperDeps, item: StructureRunsShipWorkItem): Promise<boolean> {
  // Read once so the refs checked are the refs shipped, even if the file is replaced meanwhile.
  const runs = await readRunsFile(item.localPath);
  if (!(await payloadRefsReplicated(deps.root, collectPayloadRefs(runs)))) return false;

  if (runs.length > 0) {
    const records = runs.map(withoutAnnotation);
    if (deps.structureDest.upsertRunBatch) {
      await deps.structureDest.upsertRunBatch(records);
    } else {
      for (const run of records) {
        await deps.structureDest.upsertRun(run);
      }
    }
  }
  return true;
}

async function shipTrace(
  deps: TraceShipperDeps,
  item: StructureTraceShipWorkItem,
  state: ShipperState,
): Promise<boolean> {
  if (!(await canUploadTraceJson(deps.root, item.traceId, state))) return false;

  const trace = JSON.parse(await readFile(item.localPath, 'utf-8')) as Trace;
  await deps.structureDest.upsertTrace(withoutAnnotation(trace));
  return true;
}

function withoutAnnotation<T extends Trace | TraceRun>(record: T): T {
  const { annotation: _annotation, ...rest } = record;
  return rest as T;
}

function sortStructureItems(items: ShipWorkItem[]): ShipWorkItem[] {
  return [...items].sort((left, right) => {
    const rank = (item: ShipWorkItem): number => {
      if (item.kind === 'structure-runs') return 0;
      if (item.kind === 'structure-trace') return 1;
      return 2;
    };
    return rank(left) - rank(right);
  });
}

async function canUploadTraceJson(
  root: string,
  traceId: string,
  state: ShipperState,
): Promise<boolean> {
  const runsPath = join(root, 'traces', traceId, 'runs.ndjson');
  try {
    const runsStat = await stat(runsPath);
    const runsRef = toRef(root, runsPath);
    const uploadedMtime = state.structure[runsRef];
    return uploadedMtime !== undefined && uploadedMtime >= runsStat.mtimeMs;
  } catch (error) {
    if (isEnoent(error)) return true;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
