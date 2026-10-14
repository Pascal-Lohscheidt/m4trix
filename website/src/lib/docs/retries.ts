/**
 * `<RetryDiagram>`'s model: a tool call with `.retry({ times, backoff: { base, factor, max } })`
 * that fails every attempt but the last. Delays follow core's rule: retry n waits
 * `base * factor^(n - 1)`, capped at `max`. Pure, shared by the diagram and its `.md` output.
 */
export interface RetrySpec {
  tool: string;
  caller: string;
  times: number;
  baseMs: number;
  factor: number;
  maxMs: number;
  result: string;
}

/** Reads the component's string attributes (MDX props or the raw tag in `llm.ts`). */
export function parseRetrySpec(get: (name: string) => string | undefined): RetrySpec {
  const num = (name: string, fallback: number) => {
    const value = Number(get(name) ?? fallback);
    if (Number.isNaN(value) || value < 0)
      throw new Error(`<RetryDiagram ${name}> must be a number`);
    return value;
  };
  return {
    tool: get('tool') ?? 'tool',
    caller: get('caller') ?? 'agent',
    times: Math.floor(num('times', 2)),
    baseMs: num('base', 200),
    factor: Math.max(1, num('factor', 2)),
    maxMs: num('max', Number.POSITIVE_INFINITY),
    result: get('result') ?? 'result',
  };
}

export function retryDelays(spec: RetrySpec): number[] {
  return Array.from({ length: spec.times }, (_, i) =>
    Math.min(spec.baseMs * spec.factor ** i, spec.maxMs),
  );
}

export function retryMarkdown(spec: RetrySpec): string {
  const delays = retryDelays(spec);
  const steps = delays.map(
    (ms, i) => `attempt ${i + 1} throws, the tool waits ${ms} ms (retry ${i + 1})`,
  );
  return `Diagram: \`${spec.caller}\` calls \`${spec.tool}\`; ${steps.join('; ')}; attempt ${delays.length + 1} succeeds and returns \`${spec.result}\` to \`${spec.caller}\`.`;
}
