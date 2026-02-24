import { describe, expect, test } from 'vitest';
import type { ScoreItem } from './score';
import { aggregateScoreItems } from '../runner/score-utils';
import { Score, formatScoreData } from './score';

describe('Score', () => {
  test('Score.of creates def with formatValue, formatAggregate, aggregateValues', () => {
    const customScore = Score.of<{ value: number; delta: number }>({
      id: 'custom-delta',
      name: 'Custom Delta',
      displayStrategy: 'number',
      formatValue: (d) => `${d.value} (${d.delta})`,
      formatAggregate: (d) => `Avg: ${d.value} (Δ${d.delta})`,
      aggregateValues: Score.aggregate.averageFields(['value', 'delta']),
    });

    const item = customScore.make({ value: 80, delta: 10 });
    expect(item.id).toBe('custom-delta');
    expect(item.data).toEqual({ value: 80, delta: 10 });
    expect(item.def).toBeDefined();
    expect(customScore.formatValue(item.data)).toBe('80 (10)');
    expect(customScore.formatAggregate(item.data)).toBe('Avg: 80 (Δ10)');
  });

  test('make() attaches def to item for registry-free formatting', () => {
    const customScore = Score.of<{ x: number }>({
      id: 'attach-def',
      displayStrategy: 'number',
      formatValue: (d) => String(d.x),
      formatAggregate: (d) => `Avg: ${d.x}`,
      aggregateValues: Score.aggregate.averageFields(['x']),
    });

    const item = customScore.make({ x: 42 });
    expect(item.def).toBeDefined();
    expect(item.def?.formatValue(item.data)).toBe('42');
    expect(item.def?.formatAggregate(item.data)).toBe('Avg: 42');
  });

  test('aggregateScoreItems uses item.def when available', () => {
    const customScore = Score.of<{ value: number; delta: number }>({
      id: 'agg-test',
      displayStrategy: 'number',
      formatValue: (d) => String(d.value),
      formatAggregate: (d) => `Avg: ${d.value}`,
      aggregateValues: Score.aggregate.averageFields(['value', 'delta']),
    });

    const items = [
      customScore.make({ value: 10, delta: 1 }),
      customScore.make({ value: 20, delta: 2 }),
      customScore.make({ value: 30, delta: 3 }),
    ];

    const agg = aggregateScoreItems(items as ReadonlyArray<ScoreItem>);
    expect(agg).toBeDefined();
    expect(agg!.data).toEqual({ value: 20, delta: 2 });
    expect(agg!.def).toBeDefined();
    expect(agg!.def?.formatAggregate(agg!.data)).toBe('Avg: 20');
  });

  test('make() accepts optional name override', () => {
    const customScore = Score.of<{ value: number }>({
      id: 'name-override',
      name: 'Default Label',
      displayStrategy: 'number',
      formatValue: (d) => String(d.value),
      formatAggregate: (d) => `Avg: ${d.value}`,
      aggregateValues: Score.aggregate.averageFields(['value']),
    });

    const withoutOverride = customScore.make({ value: 50 });
    expect(withoutOverride.name).toBeUndefined();

    const withOverride = customScore.make(
      { value: 50 },
      { name: 'Quality vs baseline' },
    );
    expect(withOverride.name).toBe('Quality vs baseline');
  });

  test('aggregateScoreItems preserves last non-empty item name', () => {
    const customScore = Score.of<{ value: number }>({
      id: 'agg-name',
      name: 'Def Name',
      displayStrategy: 'number',
      formatValue: (d) => String(d.value),
      formatAggregate: (d) => `Avg: ${d.value}`,
      aggregateValues: Score.aggregate.averageFields(['value']),
    });

    const items = [
      customScore.make({ value: 10 }, { name: 'First' }),
      customScore.make({ value: 20 }),
      customScore.make({ value: 30 }, { name: 'Last' }),
    ];

    const agg = aggregateScoreItems(items as ReadonlyArray<ScoreItem>);
    expect(agg).toBeDefined();
    expect(agg!.name).toBe('Last');
  });

  test('formatScoreData uses formatValue when not aggregated', () => {
    const customScore = Score.of<{ value: number }>({
      id: 'fmt-test',
      displayStrategy: 'number',
      formatValue: (d) => `val: ${d.value}`,
      formatAggregate: (d) => `avg: ${d.value}`,
      aggregateValues: Score.aggregate.averageFields(['value']),
    });

    expect(formatScoreData(customScore, { value: 50 })).toBe('val: 50');
    expect(
      formatScoreData(customScore, { value: 50 }, { isAggregated: true }),
    ).toBe('avg: 50');
  });

  test('Score.aggregate.averageFields averages numeric fields', () => {
    const agg = Score.aggregate.averageFields(['value', 'delta']);
    const result = agg([
      { value: 10, delta: 1 },
      { value: 20, delta: 3 },
      { value: 30, delta: 5 },
    ]);
    expect(result).toEqual({ value: 20, delta: 3 });
  });

  test('Score.aggregate.averageWithVariance computes mean and stdDev', () => {
    const result = Score.aggregate.averageWithVariance([
      { value: 10 },
      { value: 20 },
      { value: 30 },
    ]);
    expect(result.value).toBe(20);
    expect(result.stdDev).toBeDefined();
    expect(result.count).toBe(3);
  });

  test('Score.aggregate.all combines binary passed flags', () => {
    const result = Score.aggregate.all([
      { passed: true },
      { passed: true },
      { passed: false },
    ]);
    expect(result.passed).toBe(false);
    expect(result.passedCount).toBe(2);
    expect(result.totalCount).toBe(3);
  });

  test('Score.aggregate.all returns passed when all pass', () => {
    const result = Score.aggregate.all([{ passed: true }, { passed: true }]);
    expect(result.passed).toBe(true);
    expect(result.passedCount).toBe(2);
    expect(result.totalCount).toBe(2);
  });
});
