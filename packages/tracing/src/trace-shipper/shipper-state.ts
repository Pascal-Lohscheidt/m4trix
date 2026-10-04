import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../storage-adapter/atomic-write.js';
import type { ShipperState } from './types.js';

const STATE_DIR = '.shipper';
const STATE_FILE = 'state.json';

export function shipperStatePath(root: string): string {
  return join(root, STATE_DIR, STATE_FILE);
}

export function emptyShipperState(): ShipperState {
  return { structure: {} };
}

/**
 * Loads shipping progress. An unreadable state file is treated as empty: re-shipping structure is
 * idempotent and never touches annotations, so starting over is safe, while failing would stop the
 * sidecar for good.
 */
export async function loadShipperState(root: string): Promise<ShipperState> {
  let raw: string;
  try {
    raw = await readFile(shipperStatePath(root), 'utf-8');
  } catch (error) {
    if (isEnoent(error)) return emptyShipperState();
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ShipperState>;
    return { structure: isRecord(parsed.structure) ? parsed.structure : {} };
  } catch {
    return emptyShipperState();
  }
}

export async function saveShipperState(root: string, state: ShipperState): Promise<void> {
  await mkdir(join(root, STATE_DIR), { recursive: true });
  await writeFileAtomic(shipperStatePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
