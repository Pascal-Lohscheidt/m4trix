const registry = new Map<string, ScoreDef<unknown>>();

export type ScoreDisplayStrategy = 'bar' | 'number' | 'passFail';

export interface ScoreItem<TData = unknown> {
  readonly id: string;
  readonly data: TData;
  readonly passed?: boolean;
  /** Per-item display name override (wins over def.name in rendering) */
  readonly name?: string;
  /** Attached def for formatting/aggregation without registry lookup (avoids n/a across module boundaries) */
  readonly def?: ScoreDef<TData>;
}

export interface FormatScoreOptions {
  isAggregated?: boolean;
}

export interface ScoreDef<TData = unknown> {
  readonly id: string;
  readonly name?: string;
  readonly displayStrategy: ScoreDisplayStrategy;
  readonly formatValue: (data: TData) => string;
  readonly formatAggregate: (data: TData) => string;
  readonly aggregateValues: (values: ReadonlyArray<TData>) => TData;
  make(
    data: TData,
    options?: { definePassed?: (data: TData) => boolean; name?: string },
  ): ScoreItem<TData>;
}

/** Helper to format using the right method based on isAggregated (for consumers that need a single entry point) */
export function formatScoreData<TData>(
  def: ScoreDef<TData>,
  data: TData,
  options?: FormatScoreOptions,
): string {
  return options?.isAggregated
    ? def.formatAggregate(data)
    : def.formatValue(data);
}

/** Aggregate helpers for common patterns. Use with aggregateValues in Score.of(). */
export const ScoreAggregate = {
  /** Average numeric fields. Use for scores like { value, delta }. */
  averageFields<K extends string>(
    fields: readonly K[],
  ): (values: ReadonlyArray<Record<K, number>>) => Record<K, number> {
    return (values) => {
      const count = values.length || 1;
      const result = {} as Record<string, number>;
      for (const field of fields) {
        result[field] =
          values.reduce(
            (s, v) => s + ((v as Record<string, number>)[field] ?? 0),
            0,
          ) / count;
      }
      return result as unknown as Record<K, number>;
    };
  },

  /** Average selected numeric fields, with sample std dev tracked for `value`. */
  averageWithVariance<K extends string>(
    fields: readonly K[],
  ): (
    values: ReadonlyArray<Record<K, number>>,
  ) => Record<K, number> & { stdDev?: number; count: number } {
    return (values) => {
      const count = values.length;
      const result = {} as Record<string, number>;

      for (const field of fields) {
        result[field] =
          count === 0
            ? 0
            : values.reduce(
                (sum, item) => sum + ((item as Record<string, number>)[field] ?? 0),
                0,
              ) / count;
      }

      const valueField = 'value' as K;
      const hasValueField = fields.includes(valueField);

      if (count === 0) {
        if (hasValueField) {
          result[valueField] = 0;
        }
        return {
          ...(result as Record<K, number>),
          stdDev: undefined,
          count: 0,
        };
      }

      let stdDev: number | undefined;
      if (hasValueField && count >= 2) {
        const sum = values.reduce(
          (s, v) => s + ((v as Record<string, number>)[valueField] ?? 0),
          0,
        );
        const sumSq = values.reduce(
          (s, v) => {
            const value = (v as Record<string, number>)[valueField] ?? 0;
            return s + value * value;
          },
          0,
        );
        const mean = sum / count;
        const variance = (sumSq - count * mean * mean) / (count - 1);
        stdDev = variance > 0 ? Math.sqrt(variance) : 0;
      }

      return {
        ...values[0],
        ...(result as Record<K, number>),
        stdDev,
        count,
      };
    };
  },

  /** All runs must pass. Use for binary scores. */
  all<T extends { passed: boolean }>(
    values: ReadonlyArray<T>,
  ): T & { passedCount?: number; totalCount?: number } {
    const total = values.length;
    const passedCount = values.filter((v) => v.passed).length;
    return {
      ...values[0],
      passed: total > 0 && values.every((v) => v.passed),
      passedCount,
      totalCount: total,
    } as T & { passedCount?: number; totalCount?: number };
  },

  /** Take last value (no aggregation). Use when aggregation is not meaningful. */
  last<T>(values: ReadonlyArray<T>): T {
    return values[values.length - 1] ?? ({} as T);
  },
};

export const Score = {
  aggregate: ScoreAggregate,

  of<TData>(config: {
    id: string;
    name?: string;
    displayStrategy: ScoreDisplayStrategy;
    formatValue: (data: TData) => string;
    formatAggregate: (data: TData) => string;
    aggregateValues: (values: ReadonlyArray<TData>) => TData;
  }): ScoreDef<TData> {
    const def: ScoreDef<TData> = {
      id: config.id,
      name: config.name,
      displayStrategy: config.displayStrategy,
      formatValue: config.formatValue,
      formatAggregate: config.formatAggregate,
      aggregateValues: config.aggregateValues,
      make: (
        data: TData,
        options?: { definePassed?: (data: TData) => boolean; name?: string },
      ) => {
        const passed =
          options?.definePassed !== undefined
            ? options.definePassed(data)
            : undefined;
        return {
          id: config.id,
          data,
          ...(passed !== undefined && { passed }),
          ...(options?.name !== undefined && { name: options.name }),
          def, // Attach def so rendering/aggregation works without registry lookup
        };
      },
    };
    registry.set(config.id, def as ScoreDef<unknown>);
    return def;
  },
};

export function getScoreById(id: string): ScoreDef<unknown> | undefined {
  return registry.get(id);
}
