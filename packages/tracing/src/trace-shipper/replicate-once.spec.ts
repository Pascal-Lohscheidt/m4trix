import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayloadStoreAdapter, StructureStoreAdapter, Trace, TraceRun } from '../types.js';
import { listPending } from './list-pending.js';
import { replicateOnce } from './replicate-once.js';
import { emptyShipperState, loadShipperState, shipperStatePath } from './shipper-state.js';

describe('trace-shipper', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-trace-shipper-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('lists pending payloads and skips tmp files', async () => {
    await writePayload(root, 'trace-1', 'run-1', 'input.json', '{"a":1}');
    await mkdir(join(root, 'traces', 'trace-1', 'payloads', 'run-1'), { recursive: true });
    await writeFile(join(root, 'traces', 'trace-1', 'payloads', 'run-1', 'output.json.tmp'), '{}');

    const pending = await listPending(root, emptyShipperState());
    expect(pending.payloads).toHaveLength(1);
    expect(pending.payloads[0]).toMatchObject({
      kind: 'payload',
      ref: 'traces/trace-1/payloads/run-1/input.json',
    });
  });

  it('uploads payloads before structure and deletes local payload files', async () => {
    const inputRef = 'traces/trace-1/payloads/run-1/input.json';
    const inputPath = await writePayload(root, 'trace-1', 'run-1', 'input.json', '{"q":"hi"}');
    await writeStructure(root, 'trace-1', makeTrace(), [
      makeRun({ inputRef, outputRef: undefined }),
    ]);

    const uploadedPayloadRefs: string[] = [];
    const upsertedTraces: Trace[] = [];
    const upsertedRuns: TraceRun[][] = [];

    const payloadDest: PayloadStoreAdapter = {
      putJson: vi.fn(),
      getJson: vi.fn(),
      putStream: vi.fn(async (ref, body) => {
        uploadedPayloadRefs.push(ref);
        for await (const _chunk of body) {
          // drain
        }
        return ref;
      }),
    };

    const structureDest: StructureStoreAdapter = {
      upsertTrace: vi.fn(async (trace) => {
        upsertedTraces.push(trace);
      }),
      upsertRun: vi.fn(),
      upsertRunBatch: vi.fn(async (runs) => {
        upsertedRuns.push(runs);
      }),
      getTrace: vi.fn(),
      listTraces: vi.fn(),
      patchTraceAnnotation: vi.fn(),
      patchRunAnnotation: vi.fn(),
    };

    const first = await replicateOnce({ root, payloadDest, structureDest });
    expect(first.uploadedPayloads).toBe(1);
    expect(first.uploadedStructure).toBe(2);
    expect(uploadedPayloadRefs).toEqual([inputRef]);
    expect(upsertedTraces).toHaveLength(1);
    expect(upsertedRuns).toHaveLength(1);

    await expect(access(inputPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const state = await loadShipperState(root);
    expect(state.payloads[inputRef]).toBe(true);

    const second = await replicateOnce({ root, payloadDest, structureDest });
    expect(second.uploadedPayloads).toBe(0);
    expect(second.uploadedStructure).toBe(0);
  });

  it('defers structure upload until payload refs are replicated', async () => {
    const inputRef = 'traces/trace-1/payloads/run-1/input.json';
    await writeStructure(root, 'trace-1', makeTrace(), [makeRun({ inputRef })]);

    const upsertedTraces: Trace[] = [];
    const upsertedRuns: TraceRun[][] = [];
    const payloadDest: PayloadStoreAdapter = {
      putJson: vi.fn(),
      getJson: vi.fn(),
      putStream: vi.fn(async (ref, body) => {
        for await (const _chunk of body) {
          // drain
        }
        return ref;
      }),
    };
    const structureDest: StructureStoreAdapter = {
      upsertTrace: vi.fn(async (trace) => {
        upsertedTraces.push(trace);
      }),
      upsertRun: vi.fn(),
      upsertRunBatch: vi.fn(),
      getTrace: vi.fn(),
      listTraces: vi.fn(),
      patchTraceAnnotation: vi.fn(),
      patchRunAnnotation: vi.fn(),
    };

    const result = await replicateOnce({ root, payloadDest, structureDest });
    expect(result.uploadedPayloads).toBe(0);
    expect(result.uploadedStructure).toBe(0);
    expect(upsertedTraces).toHaveLength(0);
    expect(upsertedRuns).toHaveLength(0);
  });

  it('persists shipper state under .shipper/state.json', async () => {
    await writePayload(root, 'trace-1', 'run-1', 'input.json', '{}');

    const payloadDest: PayloadStoreAdapter = {
      putJson: vi.fn(),
      getJson: vi.fn(),
      putStream: vi.fn(async (ref, body) => {
        for await (const _chunk of body) {
          // drain
        }
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

    await replicateOnce({ root, payloadDest, structureDest });

    const raw = await readFile(shipperStatePath(root), 'utf-8');
    expect(JSON.parse(raw)).toMatchObject({
      payloads: {
        'traces/trace-1/payloads/run-1/input.json': true,
      },
    });
  });
});

async function writePayload(
  root: string,
  traceId: string,
  runId: string,
  fileName: string,
  content: string,
): Promise<string> {
  const dir = join(root, 'traces', traceId, 'payloads', runId);
  await mkdir(dir, { recursive: true });
  const absolutePath = join(dir, fileName);
  await writeFile(absolutePath, content);
  return absolutePath;
}

async function writeStructure(
  root: string,
  traceId: string,
  trace: Trace,
  runs: TraceRun[],
): Promise<void> {
  const dir = join(root, 'traces', traceId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  await writeFile(
    join(dir, 'runs.ndjson'),
    `${runs.map((run) => JSON.stringify(run)).join('\n')}\n`,
  );
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    schemaVersion: 1,
    traceId: 'trace-1',
    rootRunId: 'run-1',
    name: 'Trace 1',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    runCount: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    schemaVersion: 1,
    traceId: 'trace-1',
    runId: 'run-1',
    type: 'chain',
    name: 'Run 1',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
