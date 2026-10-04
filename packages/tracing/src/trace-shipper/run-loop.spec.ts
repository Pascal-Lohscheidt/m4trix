import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTraceShipperCliArgs, TraceShipperCliParseError } from '../trace-shipper-args.js';
import type { PayloadStoreAdapter, StructureStoreAdapter } from '../types.js';
import { parseDurationMs, parseIntervalMs, runShipperLoop } from './run-loop.js';
import type { ReplicateOnceResult, TraceShipperDeps } from './types.js';

describe('runShipperLoop', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-shipper-loop-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('runs one last replication pass after abort so late traces are not left behind', async () => {
    const { deps, uploadedRefs } = createDeps(root);
    const controller = new AbortController();
    const ticks: ReplicateOnceResult[] = [];
    let firstTick: () => void = () => {};
    const firstTickDone = new Promise<void>((resolve) => {
      firstTick = resolve;
    });

    const loop = runShipperLoop(deps, {
      intervalMs: 60_000,
      signal: controller.signal,
      onTick(result) {
        ticks.push(result);
        firstTick();
      },
    });
    await firstTickDone;
    await writePayload(root, 'late.json');
    controller.abort();

    await expect(loop).resolves.toBeUndefined();
    expect(ticks).toHaveLength(2);
    expect(uploadedRefs).toEqual(['traces/trace-1/payloads/run-1/late.json']);
  });

  it('reports a failed tick and keeps polling', async () => {
    const notADirectory = join(root, 'file');
    await writeFile(notADirectory, '');
    const { deps } = createDeps(notADirectory);
    const controller = new AbortController();
    const errors: unknown[] = [];

    await runShipperLoop(deps, {
      intervalMs: 1,
      signal: controller.signal,
      onError(error) {
        errors.push(error);
        if (errors.length === 3) controller.abort();
      },
    });

    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors[0]).toMatchObject({ code: 'ENOTDIR' });
  });

  it('fails a --once run when its only tick fails', async () => {
    const notADirectory = join(root, 'file');
    await writeFile(notADirectory, '');
    const { deps } = createDeps(notADirectory);

    await expect(runShipperLoop(deps, { intervalMs: 1, once: true })).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});

function createDeps(root: string): { deps: TraceShipperDeps; uploadedRefs: string[] } {
  const uploadedRefs: string[] = [];
  const payloadDest: PayloadStoreAdapter = {
    putJson: vi.fn(),
    getJson: vi.fn(),
    putStream: vi.fn(async (ref, body) => {
      for await (const _chunk of body) {
        // drain
      }
      uploadedRefs.push(ref);
      return ref;
    }),
  };
  const structureDest: StructureStoreAdapter = {
    upsertTrace: vi.fn(),
    upsertRun: vi.fn(),
    upsertRunBatch: vi.fn(),
    getTrace: vi.fn(),
    listTraces: vi.fn(),
    patchTraceAnnotation: vi.fn(),
    patchRunAnnotation: vi.fn(),
  };
  return { deps: { root, payloadDest, structureDest }, uploadedRefs };
}

async function writePayload(root: string, fileName: string): Promise<void> {
  const dir = join(root, 'traces', 'trace-1', 'payloads', 'run-1');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), '{}');
}

describe('parseIntervalMs', () => {
  it('parses common duration strings', () => {
    expect(parseIntervalMs('500ms')).toBe(500);
    expect(parseIntervalMs('2s')).toBe(2000);
    expect(parseIntervalMs('1m')).toBe(60_000);
    expect(parseIntervalMs('24h')).toBe(86_400_000);
  });

  it('rejects invalid intervals', () => {
    expect(() => parseIntervalMs('nope')).toThrow('Invalid interval');
    expect(() => parseIntervalMs('0s')).toThrow('Invalid interval');
  });
});

describe('parseDurationMs', () => {
  it('accepts zero for "right away"', () => {
    expect(parseDurationMs('0')).toBe(0);
    expect(parseDurationMs('5m')).toBe(300_000);
  });

  it('rejects invalid durations', () => {
    expect(() => parseDurationMs('-1s')).toThrow('Invalid duration');
  });
});

describe('parseTraceShipperCliArgs', () => {
  it('defaults root and interval', () => {
    const prev = process.env.TRACE_ROOT;
    delete process.env.TRACE_ROOT;
    try {
      expect(parseTraceShipperCliArgs(['node', 'cli'])).toEqual({
        root: '/traces',
        interval: '2s',
        once: false,
        retain: '5m',
        retainRunning: '24h',
        keepShipped: false,
      });
    } finally {
      if (prev === undefined) delete process.env.TRACE_ROOT;
      else process.env.TRACE_ROOT = prev;
    }
  });

  it('parses flags', () => {
    expect(parseTraceShipperCliArgs(['node', 'cli', '--root', './.traces', '--once'])).toEqual({
      root: './.traces',
      interval: '2s',
      once: true,
      retain: '5m',
      retainRunning: '24h',
      keepShipped: false,
    });
  });

  it('parses retention flags', () => {
    expect(
      parseTraceShipperCliArgs([
        'node',
        'cli',
        '--retain',
        '0',
        '--retain-running',
        '2h',
        '--keep-shipped',
      ]),
    ).toMatchObject({ retain: '0', retainRunning: '2h', keepShipped: true });
    expect(() => parseTraceShipperCliArgs(['node', 'cli', '--retain'])).toThrow(
      '--retain requires a value',
    );
  });

  it('throws help', () => {
    expect(() => parseTraceShipperCliArgs(['node', 'cli', '--help'])).toThrow(
      TraceShipperCliParseError,
    );
  });
});
