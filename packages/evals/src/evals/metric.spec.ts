import { describe, expect, test } from 'vitest';
import type { MetricItem } from './metric';
import { aggregateMetricItems } from '../runner/score-utils';
import { Metric } from './metric';

describe('Metric', () => {
  test('Metric.of create def with format and optional aggregate', () => {
    const customMetric = Metric.of<{ ms: number }>({
      id: 'custom-latency',
      name: 'Latency',
      format: (d) => `${d.ms}ms`,
      aggregate: (values) => ({
        ms: values.reduce((s, v) => s + v.ms, 0) / values.length,
      }),
    });

    const item = customMetric.make({ ms: 42 });
    expect(item.id).toBe('custom-latency');
    expect(item.data).toEqual({ ms: 42 });
    expect(customMetric.format(item.data)).toBe('42ms');
  });

  test('make() accepts optional name override', () => {
    const customMetric = Metric.of<{ ms: number }>({
      id: 'name-override',
      name: 'Default Latency',
      format: (d) => `${d.ms}ms`,
    });

    const withoutOverride = customMetric.make({ ms: 100 });
    expect(withoutOverride.name).toBeUndefined();

    const withOverride = customMetric.make(
      { ms: 100 },
      { name: 'Latency (model only)' },
    );
    expect(withOverride.name).toBe('Latency (model only)');
  });

  test('aggregateMetricItems preserves last non-empty item name', () => {
    const customMetric = Metric.of<{ ms: number }>({
      id: 'agg-name',
      name: 'Def Name',
      format: (d) => `${d.ms}ms`,
      aggregate: (values) => ({
        ms: values.reduce((s, v) => s + v.ms, 0) / values.length,
      }),
    });

    const items = [
      customMetric.make({ ms: 10 }, { name: 'First' }),
      customMetric.make({ ms: 20 }),
      customMetric.make({ ms: 30 }, { name: 'Last' }),
    ];

    const agg = aggregateMetricItems(items as ReadonlyArray<MetricItem>);
    expect(agg).toBeDefined();
    expect(agg!.name).toBe('Last');
    expect(agg!.data).toEqual({ ms: 20 });
  });
});
