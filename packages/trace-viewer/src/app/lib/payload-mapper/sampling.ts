import type { RunNode } from '../../types';
import type { PayloadSide } from './match';

export type RunRef = { traceId: string; run: RunNode; side: PayloadSide; ref: string };

export type RunGroup = {
  key: string;
  runType: string;
  runName: string;
  side: PayloadSide;
  refs: RunRef[];
};

export type Sample = {
  traceId: string;
  runId: string;
  runMetadata?: RunNode['metadata'];
  ref: string;
  /** Truncated (and optionally redacted) payload — this is what is sent to the model. */
  payload: unknown;
  /** Full payload, kept locally for dry runs and previews; never sent. */
  original: unknown;
};

export type SampleGroup = {
  key: string;
  runType: string;
  runName: string;
  side: PayloadSide;
  /** Number of runs in the scanned traces belonging to this group. */
  runCount: number;
  samples: Sample[];
  /** Merged type shape of the sampled payloads, TypeScript-like. */
  shape: string;
};

export function groupKeyOf(run: Pick<RunNode, 'type' | 'name'>, side: PayloadSide): string {
  return `${run.type} · ${run.name} · ${side}`;
}

export function flattenRuns(root: RunNode): RunNode[] {
  const out: RunNode[] = [];
  const visit = (node: RunNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

export function collectRunRefs(trees: { traceId: string; root: RunNode }[]): RunRef[] {
  const refs: RunRef[] = [];
  for (const tree of trees) {
    for (const run of flattenRuns(tree.root)) {
      if (run.inputRef) refs.push({ traceId: tree.traceId, run, side: 'input', ref: run.inputRef });
      if (run.outputRef)
        refs.push({ traceId: tree.traceId, run, side: 'output', ref: run.outputRef });
    }
  }
  return refs;
}

/** Groups by (run type, run name, side); largest groups first. */
export function groupRunRefs(refs: RunRef[]): RunGroup[] {
  const byKey = new Map<string, RunGroup>();
  for (const ref of refs) {
    const key = groupKeyOf(ref.run, ref.side);
    let group = byKey.get(key);
    if (!group) {
      group = { key, runType: ref.run.type, runName: ref.run.name, side: ref.side, refs: [] };
      byKey.set(key, group);
    }
    group.refs.push(ref);
  }
  return [...byKey.values()].sort(
    (a, b) => b.refs.length - a.refs.length || a.key.localeCompare(b.key),
  );
}

/** `n` evenly spaced items (first, …, last) so samples cover early and late runs. */
export function pickSpread<T>(items: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  if (items.length <= n) return [...items];
  if (n === 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return out;
}

export type SamplePlanOptions = {
  perGroup?: number;
  maxGroups?: number;
  /** Higher sorts first (e.g. unmatched groups when improving). */
  priority?: (group: RunGroup) => number;
  /** Refs that must be included (e.g. "improve with this run"). */
  pinned?: readonly string[];
};

export function planSamples(groups: RunGroup[], opts: SamplePlanOptions = {}): RunGroup[] {
  const perGroup = opts.perGroup ?? 3;
  const pinned = new Set(opts.pinned ?? []);
  const priority = opts.priority ?? (() => 0);
  const hasPinned = (g: RunGroup) => g.refs.some((r) => pinned.has(r.ref));
  const ordered = [...groups].sort(
    (a, b) => Number(hasPinned(b)) - Number(hasPinned(a)) || priority(b) - priority(a),
  );
  return ordered.slice(0, opts.maxGroups ?? 40).map((group) => {
    const pins = group.refs.filter((r) => pinned.has(r.ref));
    const rest = group.refs.filter((r) => !pinned.has(r.ref));
    return { ...group, refs: [...pins, ...pickSpread(rest, Math.max(0, perGroup - pins.length))] };
  });
}

export type TruncateLimits = {
  maxString: number;
  maxArray: number;
  maxDepth: number;
  maxKeys: number;
  /** Replace strings longer than `redactAbove` with a length placeholder. */
  redactStrings: boolean;
  redactAbove: number;
};

export const DEFAULT_TRUNCATE_LIMITS: TruncateLimits = {
  maxString: 500,
  maxArray: 20,
  maxDepth: 8,
  maxKeys: 40,
  redactStrings: false,
  redactAbove: 40,
};

export function truncatePayload(
  value: unknown,
  limits: TruncateLimits = DEFAULT_TRUNCATE_LIMITS,
): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      if (limits.redactStrings && v.length > limits.redactAbove)
        return `‹redacted ${v.length} chars›`;
      return v.length > limits.maxString
        ? `${v.slice(0, limits.maxString)}…‹+${v.length - limits.maxString} chars›`
        : v;
    }
    if (v === null || typeof v !== 'object') return v;
    if (depth >= limits.maxDepth) return Array.isArray(v) ? `‹array(${v.length})›` : '‹object›';
    if (Array.isArray(v)) {
      const items = v.slice(0, limits.maxArray).map((item) => walk(item, depth + 1));
      if (v.length > limits.maxArray) items.push(`‹+${v.length - limits.maxArray} more items›`);
      return items;
    }
    const entries = Object.entries(v);
    const out: Record<string, unknown> = {};
    for (const [k, child] of entries.slice(0, limits.maxKeys)) out[k] = walk(child, depth + 1);
    if (entries.length > limits.maxKeys) out['‹more keys›'] = entries.length - limits.maxKeys;
    return out;
  };
  return walk(value, 0);
}

// ---------------------------------------------------------------------------
// Shape inference

type Shape = {
  types: Set<string>;
  strings: Set<string>;
  tooManyStrings: boolean;
  items?: Shape;
  fields?: Map<string, { shape: Shape; count: number }>;
  objectCount: number;
};

const MAX_LITERALS = 6;
const MAX_LITERAL_LENGTH = 32;

function emptyShape(): Shape {
  return { types: new Set(), strings: new Set(), tooManyStrings: false, objectCount: 0 };
}

function addToShape(shape: Shape, value: unknown, depth: number): void {
  if (value === null || value === undefined) {
    shape.types.add('null');
    return;
  }
  if (typeof value === 'string') {
    shape.types.add('string');
    if (!shape.tooManyStrings) {
      if (value.length > MAX_LITERAL_LENGTH || value.includes('‹')) shape.tooManyStrings = true;
      else {
        shape.strings.add(value);
        if (shape.strings.size > MAX_LITERALS) shape.tooManyStrings = true;
      }
    }
    return;
  }
  if (typeof value !== 'object') {
    shape.types.add(typeof value);
    return;
  }
  if (depth > 10) {
    shape.types.add('unknown');
    return;
  }
  if (Array.isArray(value)) {
    shape.types.add('array');
    shape.items ??= emptyShape();
    for (const item of value) {
      if (typeof item === 'string' && item.startsWith('‹+')) continue;
      addToShape(shape.items, item, depth + 1);
    }
    return;
  }
  shape.types.add('object');
  shape.objectCount++;
  shape.fields ??= new Map();
  for (const [k, v] of Object.entries(value)) {
    let field = shape.fields.get(k);
    if (!field) {
      field = { shape: emptyShape(), count: 0 };
      shape.fields.set(k, field);
    }
    field.count++;
    addToShape(field.shape, v, depth + 1);
  }
}

function renderShape(shape: Shape, depth: number, maxDepth: number): string {
  const parts: string[] = [];
  for (const type of shape.types) {
    if (type === 'string') {
      parts.push(
        !shape.tooManyStrings && shape.strings.size > 0
          ? [...shape.strings].map((s) => JSON.stringify(s)).join(' | ')
          : 'string',
      );
    } else if (type === 'array') {
      const item =
        shape.items && shape.items.types.size > 0
          ? renderShape(shape.items, depth + 1, maxDepth)
          : 'never';
      parts.push(`Array<${item}>`);
    } else if (type === 'object') {
      if (!shape.fields || shape.fields.size === 0) parts.push('{}');
      else if (depth >= maxDepth) parts.push('{…}');
      else {
        const fields = [...shape.fields.entries()].slice(0, 30).map(([k, f]) => {
          const optional = f.count < shape.objectCount ? '?' : '';
          const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
          return `${key}${optional}: ${renderShape(f.shape, depth + 1, maxDepth)}`;
        });
        if (shape.fields.size > 30) fields.push('…');
        parts.push(`{ ${fields.join('; ')} }`);
      }
    } else {
      parts.push(type);
    }
  }
  return parts.length === 0 ? 'unknown' : parts.join(' | ');
}

/** Merged TypeScript-like shape for a set of payloads (short string values become literal unions). */
export function inferShape(values: unknown[], maxDepth = 7): string {
  const shape = emptyShape();
  for (const v of values) addToShape(shape, v, 0);
  return renderShape(shape, 0, maxDepth);
}

// ---------------------------------------------------------------------------
// Sample sets

export function buildSampleGroups(
  planned: RunGroup[],
  payloads: Record<string, unknown>,
  allGroups: RunGroup[],
  limits: TruncateLimits = DEFAULT_TRUNCATE_LIMITS,
): SampleGroup[] {
  const runCounts = new Map(allGroups.map((g) => [g.key, g.refs.length]));
  return planned
    .map((group) => {
      const samples: Sample[] = group.refs
        .filter((r) => payloads[r.ref] !== undefined)
        .map((r) => ({
          traceId: r.traceId,
          runId: r.run.runId,
          runMetadata: r.run.metadata,
          ref: r.ref,
          original: payloads[r.ref],
          payload: truncatePayload(payloads[r.ref], limits),
        }));
      return {
        key: group.key,
        runType: group.runType,
        runName: group.runName,
        side: group.side,
        runCount: runCounts.get(group.key) ?? group.refs.length,
        samples,
        shape: inferShape(samples.map((s) => s.payload)),
      };
    })
    .filter((g) => g.samples.length > 0);
}

export function sampleGroupChars(group: Pick<SampleGroup, 'samples' | 'shape'>): number {
  return (
    group.shape.length + group.samples.reduce((n, s) => n + JSON.stringify(s.payload).length, 0)
  );
}

/** Rough token estimate (≈4 characters per token). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Drop samples from the largest groups until the set fits `maxChars`; every group keeps at
 * least one sample. If that is still too large, trailing (lowest priority) groups are dropped.
 */
export function fitToBudget(groups: SampleGroup[], maxChars: number): SampleGroup[] {
  const out = groups.map((g) => ({ ...g, samples: [...g.samples] }));
  const total = () => out.reduce((n, g) => n + sampleGroupChars(g), 0);
  while (total() > maxChars) {
    const candidates = out.filter((g) => g.samples.length > 1);
    if (candidates.length === 0) break;
    const biggest = candidates.reduce((a, b) =>
      sampleGroupChars(a) >= sampleGroupChars(b) ? a : b,
    );
    // Drop the largest sample of the biggest group.
    let idx = 0;
    biggest.samples.forEach((s, i) => {
      if (JSON.stringify(s.payload).length > JSON.stringify(biggest.samples[idx].payload).length)
        idx = i;
    });
    biggest.samples.splice(idx, 1);
  }
  while (out.length > 1 && total() > maxChars) out.pop();
  return out;
}

/** Re-apply truncation/redaction limits from the full originals (e.g. after toggling redaction). */
export function applyLimits(group: SampleGroup, limits: TruncateLimits): SampleGroup {
  const samples = group.samples.map((s) => ({
    ...s,
    payload: truncatePayload(s.original, limits),
  }));
  return { ...group, samples, shape: inferShape(samples.map((s) => s.payload)) };
}
