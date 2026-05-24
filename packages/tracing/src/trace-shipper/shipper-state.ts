import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShipperState } from './types.js';

const STATE_DIR = '.shipper';
const STATE_FILE = 'state.json';

export function shipperStatePath(root: string): string {
  return join(root, STATE_DIR, STATE_FILE);
}

export function emptyShipperState(): ShipperState {
  return { payloads: {}, structure: {} };
}

export async function loadShipperState(root: string): Promise<ShipperState> {
  try {
    const raw = await readFile(shipperStatePath(root), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ShipperState>;
    return {
      payloads: parsed.payloads ?? {},
      structure: parsed.structure ?? {},
    };
  } catch (error) {
    if (isEnoent(error)) return emptyShipperState();
    throw error;
  }
}

export async function saveShipperState(root: string, state: ShipperState): Promise<void> {
  const path = shipperStatePath(root);
  await mkdir(join(root, STATE_DIR), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
