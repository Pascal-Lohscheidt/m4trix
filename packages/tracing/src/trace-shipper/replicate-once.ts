import { createReadStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Trace, TraceRun } from '../types.js';
import { collectStructurePayloadRefs, payloadRefsUploaded } from './collect-refs.js';
import { listPending } from './list-pending.js';
import { toRef } from './paths.js';
import { loadShipperState, saveShipperState } from './shipper-state.js';
import type { ReplicateOnceResult, ShipperState, ShipWorkItem, TraceShipperDeps } from './types.js';

export async function replicateOnce(deps: TraceShipperDeps): Promise<ReplicateOnceResult> {
  const state = await loadShipperState(deps.root);
  const pending = await listPending(deps.root, state);

  let uploadedPayloads = 0;
  let uploadedStructure = 0;

  for (const item of pending.payloads) {
    if (item.kind !== 'payload') continue;

    const stream = createReadStream(item.localPath);
    async function* streamBody(): AsyncIterable<Uint8Array> {
      for await (const chunk of stream) {
        yield chunk as Uint8Array;
      }
    }

    if (!deps.payloadDest.putStream) {
      throw new Error('Destination payload adapter does not support putStream');
    }

    await deps.payloadDest.putStream(item.ref, streamBody());
    await unlink(item.localPath);
    state.payloads[item.ref] = true;
    uploadedPayloads += 1;
  }

  const structureItems = sortStructureItems(pending.structure);
  for (const item of structureItems) {
    if (item.kind === 'structure-runs') {
      const refs = await collectStructurePayloadRefs(item.localPath, item.kind);
      if (!payloadRefsUploaded(refs, state)) continue;

      const content = await readFile(item.localPath, 'utf-8');
      const runs = content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TraceRun);

      if (runs.length > 0) {
        if (deps.structureDest.upsertRunBatch) {
          await deps.structureDest.upsertRunBatch(runs);
        } else {
          for (const run of runs) {
            await deps.structureDest.upsertRun(run);
          }
        }
      }

      state.structure[item.ref] = item.mtimeMs;
      uploadedStructure += 1;
      continue;
    }

    if (item.kind === 'structure-trace') {
      if (!(await canUploadTraceJson(deps.root, item.traceId, state))) continue;

      const trace = JSON.parse(await readFile(item.localPath, 'utf-8')) as Trace;
      await deps.structureDest.upsertTrace(trace);
      state.structure[item.ref] = item.mtimeMs;
      uploadedStructure += 1;
    }
  }

  await saveShipperState(deps.root, state);

  const after = await listPending(deps.root, state);

  return {
    uploadedPayloads,
    uploadedStructure,
    pendingPayloads: after.payloads.length,
    pendingStructure: after.structure.length,
    oldestPendingMs: after.oldestPendingMs,
  };
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
