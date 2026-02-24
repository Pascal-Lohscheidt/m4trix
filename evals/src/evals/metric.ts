const registry = new Map<string, MetricDef<unknown>>();

export interface MetricItem<TData = unknown> {
  readonly id: string;
  readonly data: TData;
  /** Per-item display name override (wins over def.name in rendering) */
  readonly name?: string;
}

export interface FormatMetricOptions {
  isAggregated?: boolean;
}

export interface MetricDef<TData = unknown> {
  readonly id: string;
  readonly name?: string;
  readonly aggregate?: (values: ReadonlyArray<TData>) => TData;
  format(data: TData, options?: FormatMetricOptions): string;
  make(data: TData, options?: { name?: string }): MetricItem<TData>;
}

export const Metric = {
  of<TData>(config: {
    id: string;
    name?: string;
    format: (data: TData, options?: FormatMetricOptions) => string;
    aggregate?: (values: ReadonlyArray<TData>) => TData;
  }): MetricDef<TData> {
    const def: MetricDef<TData> = {
      id: config.id,
      name: config.name,
      aggregate: config.aggregate,
      format: config.format,
      make: (data: TData, options?: { name?: string }) => ({
        id: config.id,
        data,
        ...(options?.name !== undefined && { name: options.name }),
      }),
    };
    registry.set(config.id, def as MetricDef<unknown>);
    return def;
  },
};

export function getMetricById(id: string): MetricDef<unknown> | undefined {
  return registry.get(id);
}
