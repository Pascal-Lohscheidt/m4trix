import { access, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Trace, TraceStatus } from '../types.js';
import { removeShippedTraces } from './cleanup.js';
import type { ShipperState } from './types.js';

const MINUTE = 60_000;
const retention = { finishedMs: 5 * MINUTE, runningMs: 60 * MINUTE };

describe('removeShippedTraces', () => {
  let root: string;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-shipper-cleanup-'));
    now = Date.now();
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('removes a finished, fully shipped trace once it has been idle past retention', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 6 * MINUTE);
    state.structure['traces/other/runs.ndjson'] = 1;

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result).toEqual({ removed: ['trace-1'], failures: [] });
    await expect(access(join(root, 'traces', 'trace-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(state.structure).toEqual({ 'traces/other/runs.ndjson': 1 });
  });

  it('keeps a finished trace that has not been idle long enough', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 4 * MINUTE);

    await expect(removeShippedTraces(root, state, retention, now)).resolves.toEqual({
      removed: [],
      failures: [],
    });
    await access(join(root, 'traces', 'trace-1', 'trace.json'));
  });

  it('keeps a trace whose structure changed after it was shipped', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 6 * MINUTE);
    state.structure['traces/trace-1/runs.ndjson'] -= 1_000;

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual([]);
  });

  it('keeps a trace whose structure was never shipped', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 6 * MINUTE);
    delete state.structure['traces/trace-1/trace.json'];

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual([]);
  });

  it('keeps a trace that still has payloads waiting to be shipped', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 6 * MINUTE);
    const payloadDir = join(root, 'traces', 'trace-1', 'payloads', 'run-1');
    await mkdir(payloadDir, { recursive: true });
    await writeFile(join(payloadDir, 'output.json'), '{}');

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual([]);
  });

  it('removes a trace whose payload folders are empty after shipping', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 6 * MINUTE);
    await mkdir(join(root, 'traces', 'trace-1', 'payloads', 'run-1'), { recursive: true });

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual(['trace-1']);
  });

  it('keeps a trace while a write is in progress', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 6 * MINUTE);
    await writeFile(join(root, 'traces', 'trace-1', 'trace.json.abc123.tmp'), '{}');

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual([]);
  });

  it('keeps a trace folder that holds files the shipper does not know about', async () => {
    const state = await writeShippedTrace(root, 'trace-1', 'success', now - 6 * MINUTE);
    await writeFile(join(root, 'traces', 'trace-1', 'notes.md'), 'keep me');

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual([]);
  });

  it('waits the longer running retention for traces that never finished', async () => {
    const recent = await writeShippedTrace(root, 'recent', 'running', now - 30 * MINUTE);
    const abandoned = await writeShippedTrace(root, 'abandoned', 'running', now - 61 * MINUTE);
    const state: ShipperState = {
      structure: { ...recent.structure, ...abandoned.structure },
    };

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual(['abandoned']);
  });

  it('removes a folder the app never flushed structure into after the running retention', async () => {
    const payloadDir = join(root, 'traces', 'crashed', 'payloads', 'run-1');
    await mkdir(payloadDir, { recursive: true });
    const traceDir = join(root, 'traces', 'crashed');
    const state: ShipperState = { structure: {} };

    await setMtime(traceDir, now - 30 * MINUTE);
    expect((await removeShippedTraces(root, state, retention, now)).removed).toEqual([]);

    await setMtime(traceDir, now - 61 * MINUTE);
    expect((await removeShippedTraces(root, state, retention, now)).removed).toEqual(['crashed']);
  });

  it('reports a trace it cannot inspect and carries on with the rest', async () => {
    const broken = await writeShippedTrace(root, 'broken', 'success', now - 6 * MINUTE);
    const brokenTrace = join(root, 'traces', 'broken', 'trace.json');
    await writeFile(brokenTrace, '{"status":');
    await setMtime(brokenTrace, now - 6 * MINUTE);
    broken.structure['traces/broken/trace.json'] = (await stat(brokenTrace)).mtimeMs;
    const healthy = await writeShippedTrace(root, 'healthy', 'error', now - 6 * MINUTE);
    const state: ShipperState = {
      structure: { ...broken.structure, ...healthy.structure },
    };

    const result = await removeShippedTraces(root, state, retention, now);

    expect(result.removed).toEqual(['healthy']);
    expect(result.failures).toEqual([
      { ref: 'traces/broken', message: expect.stringContaining('JSON') },
    ]);
  });
});

/** Writes trace.json + runs.ndjson idle since `mtime` and returns state marking both as shipped. */
async function writeShippedTrace(
  root: string,
  traceId: string,
  status: TraceStatus,
  mtime: number,
): Promise<ShipperState> {
  const dir = join(root, 'traces', traceId);
  await mkdir(dir, { recursive: true });
  const trace: Trace = {
    schemaVersion: 1,
    traceId,
    rootRunId: 'run-1',
    name: traceId,
    status,
    startTime: '2026-01-01T00:00:00.000Z',
    runCount: 1,
  };
  const tracePath = join(dir, 'trace.json');
  const runsPath = join(dir, 'runs.ndjson');
  await writeFile(tracePath, JSON.stringify(trace));
  await writeFile(runsPath, `${JSON.stringify({ runId: 'run-1', traceId })}\n`);
  await setMtime(tracePath, mtime);
  await setMtime(runsPath, mtime);

  return {
    structure: {
      [`traces/${traceId}/trace.json`]: (await stat(tracePath)).mtimeMs,
      [`traces/${traceId}/runs.ndjson`]: (await stat(runsPath)).mtimeMs,
    },
  };
}

async function setMtime(path: string, mtimeMs: number): Promise<void> {
  const seconds = mtimeMs / 1000;
  await utimes(path, seconds, seconds);
}
