import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayloadStoreAdapter, StructureStoreAdapter, Trace, TraceRun } from '../types.js';
import { listPending } from './list-pending.js';
import { replicateOnce } from './replicate-once.js';
import { emptyShipperState, shipperStatePath } from './shipper-state.js';

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

    const second = await replicateOnce({ root, payloadDest, structureDest });
    expect(second.uploadedPayloads).toBe(0);
    expect(second.uploadedStructure).toBe(0);
  });

  it('defers structure upload while a referenced payload is still waiting on local disk', async () => {
    const inputRef = 'traces/trace-1/payloads/run-1/input.json';
    await writePayload(root, 'trace-1', 'run-1', 'input.json', '{"q":"hi"}');
    await writeStructure(root, 'trace-1', makeTrace(), [makeRun({ inputRef })]);
    const destinations = createDestinations({ failPayloadsOnce: [inputRef] });

    const result = await replicateOnce({ root, ...destinations });

    expect(result).toMatchObject({ uploadedPayloads: 0, uploadedStructure: 0 });
    expect(destinations.traces.size).toBe(0);
    expect(destinations.runs.size).toBe(0);
  });

  it('persists structure progress under .shipper/state.json', async () => {
    await writeStructure(root, 'trace-1', makeTrace(), [makeRun()]);
    const destinations = createDestinations();

    await replicateOnce({ root, ...destinations });

    const raw = JSON.parse(await readFile(shipperStatePath(root), 'utf-8'));
    expect(raw).toEqual({
      structure: {
        'traces/trace-1/runs.ndjson': expect.any(Number),
        'traces/trace-1/trace.json': expect.any(Number),
      },
    });
  });

  it('recovers on the next tick when an upload fails part-way through a tick', async () => {
    const inputRef = 'traces/trace-1/payloads/run-1/input.json';
    const outputRef = 'traces/trace-1/payloads/run-1/output.json';
    await writePayload(root, 'trace-1', 'run-1', 'input.json', '{"q":"hi"}');
    await writePayload(root, 'trace-1', 'run-1', 'output.json', '{"a":"yo"}');
    await writeStructure(root, 'trace-1', makeTrace(), [makeRun({ inputRef, outputRef })]);
    const destinations = createDestinations({ failPayloadsOnce: [outputRef] });

    const first = await replicateOnce({ root, ...destinations });
    expect(first).toMatchObject({
      uploadedPayloads: 1,
      uploadedStructure: 0,
      failures: [{ ref: outputRef, message: 'S3 503' }],
    });

    const second = await replicateOnce({ root, ...destinations });
    expect(second).toMatchObject({ uploadedPayloads: 1, uploadedStructure: 2, failures: [] });
    expect(destinations.payloadRefs.sort()).toEqual([inputRef, outputRef]);
    expect(destinations.runs.get('run-1')).toMatchObject({ inputRef, outputRef });
    expect(destinations.traces.get('trace-1')).toBeDefined();
  });

  it('ships structure whose payloads an earlier interrupted tick already uploaded', async () => {
    const inputRef = 'traces/trace-1/payloads/run-1/input.json';
    await writeStructure(root, 'trace-1', makeTrace(), [makeRun({ inputRef })]);
    // State written by an older sidecar that crashed after deleting the payload.
    await mkdir(join(root, '.shipper'), { recursive: true });
    await writeFile(shipperStatePath(root), JSON.stringify({ payloads: {}, structure: {} }));
    const destinations = createDestinations();

    const result = await replicateOnce({ root, ...destinations });

    expect(result).toMatchObject({ uploadedStructure: 2, pendingStructure: 0 });
    expect(destinations.runs.get('run-1')).toMatchObject({ inputRef });
  });

  it('keeps shipping other traces when one item keeps failing', async () => {
    await writeStructure(root, 'poisoned', makeTrace({ traceId: 'poisoned' }), [
      makeRun({ traceId: 'poisoned', runId: 'bad-run' }),
    ]);
    await writeStructure(root, 'healthy', makeTrace({ traceId: 'healthy' }), [
      makeRun({ traceId: 'healthy', runId: 'good-run' }),
    ]);
    const destinations = createDestinations({ failRunIds: ['bad-run'] });

    const result = await replicateOnce({ root, ...destinations });

    expect(result.failures).toEqual([
      { ref: 'traces/poisoned/runs.ndjson', message: 'item too large' },
    ]);
    expect(destinations.runs.has('good-run')).toBe(true);
    expect(destinations.traces.has('healthy')).toBe(true);
    expect(destinations.traces.has('poisoned')).toBe(false);
    expect(result.pendingStructure).toBe(2);
  });

  it('never ships annotations, so hosted review edits are not overwritten', async () => {
    await writeStructure(root, 'trace-1', makeTrace({ annotation: { local: true } }), [
      makeRun({ annotation: { local: 'run' } }),
    ]);
    const destinations = createDestinations();

    await replicateOnce({ root, ...destinations });

    expect(destinations.traces.get('trace-1')).toEqual(makeTrace());
    expect(destinations.runs.get('run-1')).toEqual(makeRun());
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

type DestinationOptions = {
  failPayloadsOnce?: string[];
  failRunIds?: string[];
};

function createDestinations(options: DestinationOptions = {}) {
  const failOnce = new Set(options.failPayloadsOnce);
  const payloadRefs: string[] = [];
  const traces = new Map<string, Trace>();
  const runs = new Map<string, TraceRun>();

  const payloadDest: PayloadStoreAdapter = {
    putJson: vi.fn(),
    getJson: vi.fn(),
    putStream: vi.fn(async (ref, body) => {
      for await (const _chunk of body) {
        // drain
      }
      if (failOnce.delete(ref)) throw new Error('S3 503');
      payloadRefs.push(ref);
      return ref;
    }),
  };
  const structureDest: StructureStoreAdapter = {
    upsertTrace: vi.fn(async (trace) => {
      traces.set(trace.traceId, trace);
    }),
    upsertRun: vi.fn(),
    upsertRunBatch: vi.fn(async (batch) => {
      if (batch.some((run) => options.failRunIds?.includes(run.runId))) {
        throw new Error('item too large');
      }
      for (const run of batch) runs.set(run.runId, run);
    }),
    getTrace: vi.fn(),
    listTraces: vi.fn(),
    patchTraceAnnotation: vi.fn(),
    patchRunAnnotation: vi.fn(),
  };

  return { payloadDest, structureDest, payloadRefs, traces, runs };
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
