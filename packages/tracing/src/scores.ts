import { isPlainObject } from './annotation-merge.js';
import type { TraceAnnotation } from './types.js';

/** Who or what produced a score. */
export type ScoreSource = 'human' | 'llm_judge' | 'eval' | 'heuristic' | (string & {});

/** A named judgement of a trace or run: a number, a pass/fail, or a label. */
export type TraceScore = {
  value: number | boolean | string;
  source?: ScoreSource;
  comment?: string;
  author?: string;
  createdAt: string;
};

export type ScoreInput = {
  traceId: string;
  /** Scores one run of the trace instead of the whole trace. */
  runId?: string;
  name: string;
  value: TraceScore['value'];
  source?: ScoreSource;
  comment?: string;
  author?: string;
};

/**
 * Scores live in the annotation under this key, one entry per score name. Each score is written as
 * a deep-merge patch, so storage adapters apply it atomically and scores with different names
 * never overwrite each other. Scoring the same name again replaces it: the patch sets every field,
 * absent ones to `null`, so nothing of the old score survives the merge.
 */
export const SCORES_ANNOTATION_KEY = 'scores';

export function scoreAnnotationPatch(input: ScoreInput, now = new Date()): TraceAnnotation {
  const name = input.name.trim();
  if (!name) throw new Error('Score name must not be empty');
  if (typeof input.value === 'number' && !Number.isFinite(input.value)) {
    throw new Error(`Score "${name}" must be a finite number, got ${input.value}`);
  }

  const score = {
    value: input.value,
    source: input.source || null,
    comment: input.comment || null,
    author: input.author || null,
    createdAt: now.toISOString(),
  };
  return { [SCORES_ANNOTATION_KEY]: { [name]: score } };
}

/** The well-formed scores in an annotation, by name. */
export function readScores(annotation: TraceAnnotation | undefined): Record<string, TraceScore> {
  const scores = annotation?.[SCORES_ANNOTATION_KEY];
  if (!isPlainObject(scores)) return {};

  return Object.fromEntries(
    Object.entries(scores).flatMap(([name, score]) =>
      isScore(score) ? [[name, withoutNulls(score)]] : [],
    ),
  );
}

function withoutNulls(score: TraceScore): TraceScore {
  return Object.fromEntries(
    Object.entries(score).filter(([, value]) => value !== null),
  ) as TraceScore;
}

function isScore(value: unknown): value is TraceScore {
  if (!isPlainObject(value) || typeof value.createdAt !== 'string') return false;
  return ['number', 'boolean', 'string'].includes(typeof value.value);
}
