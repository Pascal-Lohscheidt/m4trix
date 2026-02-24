import type { MetricItem } from '../evals/metric';
import type { ScoreDef, ScoreItem } from '../evals/score';
import { getMetricById, getScoreById } from '../evals';

function getScoreDef(item: ScoreItem): ScoreDef<unknown> | undefined {
  return item.def ?? getScoreById(item.id);
}

export function aggregateScoreItems(
  items: ReadonlyArray<ScoreItem>,
): ScoreItem | undefined {
  if (items.length === 0) return undefined;
  const def = getScoreDef(items[0]);
  if (!def?.aggregateValues) return items[items.length - 1];
  const aggregated = def.aggregateValues(items.map((i) => i.data as never));
  return { ...items[0], data: aggregated, def };
}

export function aggregateMetricItems(
  items: ReadonlyArray<MetricItem>,
): MetricItem | undefined {
  if (items.length === 0) return undefined;
  const def = getMetricById(items[0].id);
  if (!def?.aggregate) return items[items.length - 1];
  const aggregated = def.aggregate(items.map((i) => i.data as never));
  return { ...items[0], data: aggregated };
}

export function toNumericScoreFromScores(
  scores: ReadonlyArray<ScoreItem>,
): number | undefined {
  for (const item of scores) {
    const def = getScoreDef(item);
    if (def && def.displayStrategy === 'bar' && typeof item.data === 'object' && item.data !== null && 'value' in item.data) {
      const value = (item.data as { value: unknown }).value;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    const numeric = toNumericScore(item.data);
    if (numeric !== undefined) {
      return numeric;
    }
  }
  return undefined;
}

export function toNumericScore(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (
    'score' in obj &&
    typeof obj.score === 'number' &&
    Number.isFinite(obj.score)
  ) {
    return obj.score;
  }
  const numberValues = Object.values(value).filter(
    (entry): entry is number =>
      typeof entry === 'number' && Number.isFinite(entry),
  );
  if (numberValues.length === 0) {
    return undefined;
  }
  return (
    numberValues.reduce((sum, entry) => sum + entry, 0) / numberValues.length
  );
}
