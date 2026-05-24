import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { isShipperPath, isTmpFile, toRef } from './paths.js';
import type { ShipperState, ShipWorkItem } from './types.js';

export type ListPendingResult = {
  payloads: ShipWorkItem[];
  structure: ShipWorkItem[];
  oldestPendingMs: number | null;
};

export async function listPending(root: string, state: ShipperState): Promise<ListPendingResult> {
  const payloads: ShipWorkItem[] = [];
  const structure: ShipWorkItem[] = [];
  let oldestPendingMs: number | null = null;

  const tracesDir = join(root, 'traces');
  let traceIds: string[];
  try {
    const entries = await readdir(tracesDir, { withFileTypes: true });
    traceIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if (isEnoent(error)) {
      return { payloads, structure, oldestPendingMs };
    }
    throw error;
  }

  for (const traceId of traceIds) {
    const traceDir = join(tracesDir, traceId);
    const traceJsonPath = join(traceDir, 'trace.json');
    const runsPath = join(traceDir, 'runs.ndjson');

    await collectPayloads(root, join(traceDir, 'payloads'), payloads, state);

    await maybeAddStructureItem(root, traceId, traceJsonPath, 'structure-trace', structure, state);
    await maybeAddStructureItem(root, traceId, runsPath, 'structure-runs', structure, state);
  }

  for (const item of [...payloads, ...structure]) {
    if (oldestPendingMs === null || item.mtimeMs < oldestPendingMs) {
      oldestPendingMs = item.mtimeMs;
    }
  }

  return { payloads, structure, oldestPendingMs };
}

async function collectPayloads(
  root: string,
  dir: string,
  out: ShipWorkItem[],
  state: ShipperState,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectPayloads(root, absolutePath, out, state);
      continue;
    }
    if (!entry.isFile() || isTmpFile(entry.name)) continue;

    const ref = toRef(root, absolutePath);
    if (isShipperPath(ref)) continue;
    if (state.payloads[ref]) continue;

    const fileStat = await stat(absolutePath);
    out.push({
      kind: 'payload',
      ref,
      localPath: absolutePath,
      mtimeMs: fileStat.mtimeMs,
    });
  }
}

async function maybeAddStructureItem(
  root: string,
  traceId: string,
  absolutePath: string,
  kind: 'structure-trace' | 'structure-runs',
  out: ShipWorkItem[],
  state: ShipperState,
): Promise<void> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) return;

    const ref = toRef(root, absolutePath);
    const lastUploadedMtime = state.structure[ref];
    if (lastUploadedMtime !== undefined && fileStat.mtimeMs <= lastUploadedMtime) {
      return;
    }

    out.push({
      kind,
      traceId,
      ref,
      localPath: absolutePath,
      mtimeMs: fileStat.mtimeMs,
    });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
