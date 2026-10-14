import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  readScores,
  scoreAnnotationPatch,
  Tracer,
  TraceStore,
  TraceViewerApi,
} from './index.js';

describe('scoreAnnotationPatch', () => {
  const now = new Date('2026-05-01T12:00:00.000Z');

  it('builds a deep-merge patch keyed by the score name', () => {
    expect(
      scoreAnnotationPatch(
        { traceId: 't', name: ' helpfulness ', value: 0.8, source: 'llm_judge', comment: 'clear' },
        now,
      ),
    ).toEqual({
      scores: {
        helpfulness: {
          value: 0.8,
          source: 'llm_judge',
          comment: 'clear',
          author: null,
          createdAt: '2026-05-01T12:00:00.000Z',
        },
      },
    });
  });

  it('accepts pass/fail and label scores', () => {
    expect(scoreAnnotationPatch({ traceId: 't', name: 'correct', value: true }, now)).toMatchObject(
      {
        scores: { correct: { value: true } },
      },
    );
    expect(
      scoreAnnotationPatch({ traceId: 't', name: 'tone', value: 'friendly' }, now),
    ).toMatchObject({
      scores: { tone: { value: 'friendly' } },
    });
  });

  it.each([
    [{ name: '  ', value: 1 }, 'must not be empty'],
    [{ name: 'x', value: Number.NaN }, 'finite number'],
    [{ name: 'x', value: Number.POSITIVE_INFINITY }, 'finite number'],
  ])('rejects %j', (input, message) => {
    expect(() => scoreAnnotationPatch({ traceId: 't', ...input })).toThrow(message);
  });
});

describe('readScores', () => {
  it('drops the nulls a score patch writes for absent fields', () => {
    expect(readScores(scoreAnnotationPatch({ traceId: 't', name: 'x', value: 1 }))).toEqual({
      x: { value: 1, createdAt: expect.any(String) },
    });
  });

  it('returns well-formed scores and skips anything else', () => {
    expect(
      readScores({
        scores: {
          good: { value: 1, createdAt: '2026-01-01T00:00:00.000Z' },
          noDate: { value: 1 },
          badValue: { value: { nested: true }, createdAt: '2026-01-01T00:00:00.000Z' },
          notObject: 3,
        },
        other: 'kept elsewhere',
      }),
    ).toEqual({ good: { value: 1, createdAt: '2026-01-01T00:00:00.000Z' } });
    expect(readScores(undefined)).toEqual({});
    expect(readScores({ scores: [] })).toEqual({});
  });
});

describe('scoring traces', () => {
  let root: string;
  let traceStore: TraceStore;
  let api: TraceViewerApi;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-scores-'));
    traceStore = TraceStore.of({
      structureStoreAdapter: new FsStructureStoreAdapter({ path: root }),
      payloadStoreAdapter: new FsPayloadStoreAdapter({ path: root }),
    });
    api = TraceViewerApi.from(traceStore);
    const tracer = Tracer.from(traceStore);
    await tracer.handleChainStart({}, { question: 'hi' }, 'root', undefined, ['prod'], {
      env: 'test',
    });
    await tracer.handleToolStart({}, 'q', 'tool', 'root');
    await tracer.handleToolEnd('result', 'tool');
    await tracer.handleChainEnd({ answer: 'hello' }, 'root');
    await tracer.flush();
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('keeps scores written concurrently under different names', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `metric-${index}`);

    await Promise.all(
      names.map((name, index) => api.score({ traceId: 'root', name, value: index })),
    );

    const scores = readScores((await api.getTrace('root'))?.trace.annotation);
    expect(Object.keys(scores).sort()).toEqual([...names].sort());
  });

  it('replaces a score scored again under the same name, keeping other annotation data', async () => {
    await api.patchTraceAnnotation({ traceId: 'root', annotation: { review: 'needs work' } });
    await api.score({
      traceId: 'root',
      name: 'quality',
      value: 0.2,
      source: 'human',
      author: 'pascal',
    });

    const rescored = await api.score({
      traceId: 'root',
      name: 'quality',
      value: 0.9,
      source: 'eval',
    });

    expect(rescored).toMatchObject({ value: 0.9, source: 'eval' });
    expect(rescored).not.toHaveProperty('author');
    expect((await api.getTrace('root'))?.trace.annotation).toMatchObject({
      review: 'needs work',
      scores: { quality: { value: 0.9 } },
    });
  });

  it('scores a single run', async () => {
    await expect(
      api.score({ traceId: 'root', runId: 'tool', name: 'relevant', value: false }),
    ).resolves.toMatchObject({ value: false });

    const tool = (await api.getTrace('root'))?.runs.find((run) => run.runId === 'tool');
    expect(readScores(tool?.annotation)).toEqual({
      relevant: expect.objectContaining({ value: false }),
    });
  });

  it('returns null for unknown traces and runs', async () => {
    await expect(api.score({ traceId: 'missing', name: 'x', value: 1 })).resolves.toBeNull();
    await expect(
      api.score({ traceId: 'root', runId: 'missing', name: 'x', value: 1 }),
    ).resolves.toBeNull();
  });

  it('exports the root input, output, and scores as an evaluation example', async () => {
    await api.score({ traceId: 'root', name: 'quality', value: 1 });

    await expect(api.getTraceExample('root')).resolves.toEqual({
      traceId: 'root',
      name: 'chain',
      input: { question: 'hi' },
      output: { answer: 'hello' },
      status: 'success',
      tags: ['prod'],
      metadata: { env: 'test' },
      scores: { quality: expect.objectContaining({ value: 1 }) },
    });
    await expect(api.getTraceExample('missing')).resolves.toBeNull();
  });
});
