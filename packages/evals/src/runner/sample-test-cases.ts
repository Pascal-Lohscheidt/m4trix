import { randomUUID } from 'node:crypto';

import type { RunConfigSampling } from '../evals/run-config.js';
import type { CollectedTestCase } from './events.js';

/** True when `sampling` requests a subset (`count` or `percent`). */
export function isRunConfigSamplingActive(sampling: RunConfigSampling | undefined): boolean {
  if (sampling === undefined) {
    return false;
  }
  return sampling.count !== undefined || sampling.percent !== undefined;
}

function hashStringToSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], random: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const vi = arr[i];
    const vj = arr[j];
    if (vi !== undefined && vj !== undefined) {
      arr[i] = vj;
      arr[j] = vi;
    }
  }
}

function computeSampleSize(n: number, sampling: RunConfigSampling): number {
  if (n === 0) {
    return 0;
  }
  if (sampling.count !== undefined) {
    return Math.min(sampling.count, n);
  }
  if (sampling.percent !== undefined) {
    const k = Math.round((sampling.percent / 100) * n);
    return Math.min(Math.max(0, k), n);
  }
  return n;
}

/**
 * Returns a random subset of test cases when {@link isRunConfigSamplingActive} is true;
 * otherwise returns a copy of `cases` unchanged.
 */
export function sampleCollectedTestCases(
  cases: ReadonlyArray<CollectedTestCase>,
  sampling: RunConfigSampling | undefined,
): CollectedTestCase[] {
  if (sampling === undefined || !isRunConfigSamplingActive(sampling)) {
    return [...cases];
  }
  const active = sampling;
  const n = cases.length;
  const k = computeSampleSize(n, active);
  if (k === 0) {
    return [];
  }
  const seedStr = active.seed !== undefined ? active.seed : randomUUID();
  const rng = createMulberry32(hashStringToSeed(seedStr));
  const copy = [...cases];
  shuffleInPlace(copy, rng);
  return copy.slice(0, k);
}
