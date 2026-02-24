import { Score } from '../score';

export interface PercentScoreData {
  value: number;
  stdDev?: number;
  count?: number;
}

export const percentScore = Score.of<PercentScoreData>({
  id: 'percent',
  name: 'Score',
  displayStrategy: 'bar',
  formatValue: (data) => data.value.toFixed(2),
  formatAggregate: (data) =>
    data.stdDev != null
      ? `Avg: ${data.value.toFixed(2)} ± ${data.stdDev.toFixed(2)}`
      : `Avg: ${data.value.toFixed(2)}`,
  aggregateValues: Score.aggregate.averageWithVariance,
});

export interface BinaryScoreData {
  passed: boolean;
  passedCount?: number;
  totalCount?: number;
}

export const binaryScore = Score.of<BinaryScoreData>({
  id: 'binary',
  name: 'Result',
  displayStrategy: 'passFail',
  formatValue: (data) => (data.passed ? 'PASSED' : 'NOT PASSED'),
  formatAggregate: (data) => {
    const base = data.passed ? 'All: PASSED' : 'Some: FAILED';
    if (
      data.passedCount != null &&
      data.totalCount != null &&
      data.totalCount > 1
    ) {
      return `${base} (${data.passedCount}/${data.totalCount})`;
    }
    return base;
  },
  aggregateValues: Score.aggregate.all,
});
