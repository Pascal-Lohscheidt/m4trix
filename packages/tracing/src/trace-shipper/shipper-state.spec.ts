import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../storage-adapter/atomic-write.js';
import { loadShipperState, saveShipperState, shipperStatePath } from './shipper-state.js';

vi.mock('../storage-adapter/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage-adapter/atomic-write.js')>();
  return { writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

describe('shipper state', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-shipper-state-'));
    vi.mocked(writeFileAtomic).mockClear();
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('round-trips structure progress through an atomic write', async () => {
    await saveShipperState(root, { structure: { 'traces/t/runs.ndjson': 42 } });

    expect(writeFileAtomic).toHaveBeenCalledWith(shipperStatePath(root), expect.any(String));
    await expect(loadShipperState(root)).resolves.toEqual({
      structure: { 'traces/t/runs.ndjson': 42 },
    });
  });

  it('drops the payload ref map that older sidecars kept', async () => {
    await writeState(
      root,
      JSON.stringify({ payloads: { 'traces/t/a.json': true }, structure: {} }),
    );

    await expect(loadShipperState(root)).resolves.toEqual({ structure: {} });
  });

  it('starts fresh when the state file is unreadable instead of failing every tick', async () => {
    await writeState(root, '{"structure": {"traces/t/runs.ndj');

    await expect(loadShipperState(root)).resolves.toEqual({ structure: {} });
  });

  it('starts fresh when no state file exists yet', async () => {
    await expect(loadShipperState(root)).resolves.toEqual({ structure: {} });
  });
});

async function writeState(root: string, content: string): Promise<void> {
  await mkdir(join(root, '.shipper'), { recursive: true });
  await writeFile(shipperStatePath(root), content);
}
