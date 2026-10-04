import type { Dirent, Stats } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Trace } from '../types.js';
import { toRef } from './paths.js';
import type { RetentionOptions, ShipFailure, ShipperState } from './types.js';

const KNOWN_ENTRIES = new Set(['trace.json', 'runs.ndjson', 'payloads']);

export type RemoveShippedTracesResult = {
  removed: string[];
  failures: ShipFailure[];
};

/**
 * Deletes local trace folders that are fully replicated: every structure file was shipped at its
 * current mtime, no payload is left, and the trace has been idle for the retention period (longer
 * for traces still marked running, e.g. after an app crash). Their state entries are dropped too.
 * Folders mid-write or holding unknown files are left alone.
 */
export async function removeShippedTraces(
  root: string,
  state: ShipperState,
  retention: RetentionOptions,
  now: number = Date.now(),
): Promise<RemoveShippedTracesResult> {
  const result: RemoveShippedTracesResult = { removed: [], failures: [] };

  for (const traceId of await listTraceIds(root)) {
    const traceDir = join(root, 'traces', traceId);
    try {
      if (!(await isRemovable(root, traceDir, state, retention, now))) continue;
      await rm(traceDir, { recursive: true, force: true });
      forgetTrace(state, traceId);
      result.removed.push(traceId);
    } catch (error) {
      result.failures.push({
        ref: `traces/${traceId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function isRemovable(
  root: string,
  traceDir: string,
  state: ShipperState,
  retention: RetentionOptions,
  now: number,
): Promise<boolean> {
  const entries = await readdir(traceDir, { withFileTypes: true });
  if (entries.some((entry) => !KNOWN_ENTRIES.has(entry.name))) return false;
  if (await containsFiles(join(traceDir, 'payloads'))) return false;

  let lastChangeMs: number | undefined;
  let finished = false;
  for (const name of ['trace.json', 'runs.ndjson']) {
    const path = join(traceDir, name);
    const fileStat = await statIfExists(path);
    if (!fileStat) continue;

    const shippedMtime = state.structure[toRef(root, path)];
    if (shippedMtime === undefined || shippedMtime < fileStat.mtimeMs) return false;
    lastChangeMs = Math.max(lastChangeMs ?? 0, fileStat.mtimeMs);
    if (name === 'trace.json') {
      const trace = JSON.parse(await readFile(path, 'utf-8')) as Trace;
      finished = trace.status !== 'running';
    }
  }

  // A folder the app never flushed structure into is judged by the folder's own mtime.
  lastChangeMs ??= (await stat(traceDir)).mtimeMs;
  const retainMs = finished ? retention.finishedMs : retention.runningMs;
  return now - lastChangeMs >= retainMs;
}

/** True when the folder (recursively) holds anything but empty folders. */
async function containsFiles(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) return true;
    if (await containsFiles(join(dir, entry.name))) return true;
  }
  return false;
}

async function listTraceIds(root: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, 'traces'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function forgetTrace(state: ShipperState, traceId: string): void {
  const prefix = `traces/${traceId}/`;
  for (const ref of Object.keys(state.structure)) {
    if (ref.startsWith(prefix)) delete state.structure[ref];
  }
}

async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
