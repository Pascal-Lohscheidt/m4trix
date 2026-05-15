import type { RunSubtreeRollup, TokenRollup } from './types';

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function emptySubtreeRollup(): RunSubtreeRollup {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, hasUsage: false };
}

export function finalizeTokenRollup(rollup: TokenRollup): void {
  if (rollup.totalTokens === 0 && (rollup.promptTokens > 0 || rollup.completionTokens > 0)) {
    rollup.totalTokens = rollup.promptTokens + rollup.completionTokens;
  }
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
