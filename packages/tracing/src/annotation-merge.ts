import type { TraceAnnotation } from './types.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge or replace trace/run annotations. Returns `undefined` when cleared. */
export function mergeTraceAnnotation(
  existing: TraceAnnotation | undefined,
  incoming: TraceAnnotation,
  merge = true,
): TraceAnnotation | undefined {
  if (!merge) {
    return Object.keys(incoming).length === 0 ? undefined : { ...incoming };
  }

  if (!existing) return { ...incoming };
  return deepMerge(existing, incoming);
}

function deepMerge(target: TraceAnnotation, source: TraceAnnotation): TraceAnnotation {
  const result: TraceAnnotation = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key] as TraceAnnotation, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
