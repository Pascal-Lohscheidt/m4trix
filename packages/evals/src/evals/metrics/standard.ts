import { aggregateLatencyAverage, aggregateTokenCountSum } from '../aggregators';
import { Metric } from '../metric';

export interface TokenCountData {
  input?: number;
  output?: number;
  inputCached?: number;
  outputCached?: number;
}

export const tokenCountMetric = Metric.of<TokenCountData>({
  id: 'token-count',
  name: 'Tokens',
  aggregate: aggregateTokenCountSum,
  format: (data, options) => {
    const input = data.input ?? 0;
    const output = data.output ?? 0;
    const inputCached = data.inputCached ?? 0;
    const outputCached = data.outputCached ?? 0;
    const cached = inputCached + outputCached;
    const base = `in:${input} out:${output} cached:${cached}`;
    return options?.isAggregated ? `Total: ${base}` : base;
  },
});

export interface LatencyData {
  ms: number;
}

export const latencyMetric = Metric.of<LatencyData>({
  id: 'latency',
  name: 'Latency',
  aggregate: aggregateLatencyAverage,
  format: (data, options) =>
    options?.isAggregated ? `Avg: ${data.ms}ms` : `${data.ms}ms`,
});
