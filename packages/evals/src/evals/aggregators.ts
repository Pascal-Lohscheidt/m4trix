/** Average of numeric `value` fields (e.g. for percentScore) */
export function aggregateAverage(values: ReadonlyArray<{ value: number }>): {
  value: number;
} {
  if (values.length === 0) {
    return { value: 0 };
  }
  const sum = values.reduce((s, v) => s + v.value, 0);
  return { value: sum / values.length };
}

/** Average with sample std dev (for percentScore when aggregated) */
export function aggregateAverageWithVariance(
  values: ReadonlyArray<{ value: number }>,
): { value: number; stdDev?: number; count: number } {
  if (values.length === 0) {
    return { value: 0, count: 0 };
  }
  const sum = values.reduce((s, v) => s + v.value, 0);
  const sumSq = values.reduce((s, v) => s + v.value * v.value, 0);
  const mean = sum / values.length;
  let stdDev: number | undefined;
  if (values.length >= 2) {
    const variance = (sumSq - values.length * mean * mean) / (values.length - 1);
    stdDev = variance > 0 ? Math.sqrt(variance) : 0;
  }
  return { value: mean, stdDev, count: values.length };
}

/** All runs must pass (for binaryScore). Returns passed and count for spread display. */
export function aggregateAll(values: ReadonlyArray<{ passed: boolean }>): {
  passed: boolean;
  passedCount?: number;
  totalCount?: number;
} {
  const total = values.length;
  const passedCount = values.filter((v) => v.passed).length;
  return {
    passed: total > 0 && values.every((v) => v.passed),
    passedCount,
    totalCount: total,
  };
}

type TokenCountSum = {
  input: number;
  output: number;
  inputCached: number;
  outputCached: number;
};

/** Sum token counts across reruns */
export function aggregateTokenCountSum(
  values: ReadonlyArray<{
    input?: number;
    output?: number;
    inputCached?: number;
    outputCached?: number;
  }>,
): TokenCountSum {
  const initial: TokenCountSum = {
    input: 0,
    output: 0,
    inputCached: 0,
    outputCached: 0,
  };
  return values.reduce<TokenCountSum>(
    (acc, v) => ({
      input: acc.input + (v.input ?? 0),
      output: acc.output + (v.output ?? 0),
      inputCached: acc.inputCached + (v.inputCached ?? 0),
      outputCached: acc.outputCached + (v.outputCached ?? 0),
    }),
    initial,
  );
}

/** Average latency across reruns */
export function aggregateLatencyAverage(
  values: ReadonlyArray<{ ms: number }>,
): { ms: number } {
  if (values.length === 0) {
    return { ms: 0 };
  }
  const sum = values.reduce((s, v) => s + v.ms, 0);
  return { ms: sum / values.length };
}
