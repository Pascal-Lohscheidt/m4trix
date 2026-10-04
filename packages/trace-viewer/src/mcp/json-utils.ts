import { type PathSegment, parsePath } from '../app/lib/payload-mapper/json-path';

/** A scalar leaf of a payload, addressed by a JSONPath that `evaluateWithPaths` accepts. */
export type PayloadLeaf = { path: string; text: string };

const IDENT = /^[A-Za-z_$][\w$-]*$/;
const MAX_DECODE_DEPTH = 64;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function appendKey(path: string, key: string): string {
  return IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function appendIndex(path: string, index: number): string {
  return `${path}[${index}]`;
}

function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Replaces strings that contain serialized JSON objects/arrays with their parsed value.
 * Tool inputs are frequently stored as `"{\"query\":…}"`; decoding makes them searchable
 * and addressable by path like any other structure.
 */
export function decodeJsonStrings(value: unknown, depth = 0): unknown {
  if (depth > MAX_DECODE_DEPTH) return value;
  if (typeof value === 'string') {
    const parsed = tryParseJsonString(value);
    return parsed === undefined ? value : decodeJsonStrings(parsed, depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => decodeJsonStrings(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = decodeJsonStrings(item, depth + 1);
    return out;
  }
  return value;
}

/** Flattens a payload into its string/number/boolean leaves. `null` leaves are skipped. */
export function flattenLeaves(value: unknown, path = '$', out: PayloadLeaf[] = []): PayloadLeaf[] {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') {
    out.push({ path, text: value });
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.push({ path, text: String(value) });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenLeaves(item, appendIndex(path, index), out);
    });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) flattenLeaves(item, appendKey(path, key), out);
  }
  return out;
}

export type PathMatch = { path: string; value: unknown };

/** Like `evaluatePath`, but returns the concrete path of every match. */
export function evaluateWithPaths(
  scope: unknown,
  path: string,
): { ok: true; matches: PathMatch[] } | { ok: false; error: string } {
  const parsed = parsePath(path);
  if (!parsed.ok) return parsed;

  let current: PathMatch[] = [{ path: '$', value: scope }];
  for (const segment of parsed.segments) {
    current = current.flatMap((match) => stepSegment(match, segment));
    if (current.length === 0) break;
  }
  return { ok: true, matches: current.filter((match) => match.value !== undefined) };
}

function stepSegment(match: PathMatch, segment: PathSegment): PathMatch[] {
  const { value, path } = match;
  if (value === null || typeof value !== 'object') return [];
  if (segment.type === 'key') {
    if (Array.isArray(value) || !Object.hasOwn(value, segment.key)) return [];
    return [
      {
        path: appendKey(path, segment.key),
        value: (value as Record<string, unknown>)[segment.key],
      },
    ];
  }
  if (segment.type === 'index') {
    if (!Array.isArray(value)) return [];
    const index = segment.index < 0 ? value.length + segment.index : segment.index;
    if (index < 0 || index >= value.length) return [];
    return [{ path: appendIndex(path, index), value: value[index] }];
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => ({ path: appendIndex(path, index), value: item }));
  }
  return Object.entries(value).map(([key, item]) => ({ path: appendKey(path, key), value: item }));
}

export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ⏎ ');
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function safeStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, null, indent) ?? String(value);
  } catch {
    return String(value);
  }
}

export function payloadSize(value: unknown): number {
  return safeStringify(value).length;
}

function describeScalar(value: unknown, maxStringChars: number): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return `string(${value.length}) ${JSON.stringify(truncate(oneLine(value), maxStringChars))}`;
  }
  return `${typeof value} ${String(value)}`;
}

export type OutlineOptions = {
  maxDepth?: number;
  maxLines?: number;
  maxStringChars?: number;
  /** Array items shown per array before collapsing the rest into a count. */
  maxArrayItems?: number;
};

/**
 * Structure overview of a payload: one line per node with its concrete path, type and size.
 * Lets an agent pick a precise `path` for `get_payload` without reading the whole payload.
 */
export function outlinePayload(
  value: unknown,
  rootPath = '$',
  options: OutlineOptions = {},
): string {
  const maxDepth = options.maxDepth ?? 4;
  const maxLines = options.maxLines ?? 120;
  const maxStringChars = options.maxStringChars ?? 80;
  const maxArrayItems = options.maxArrayItems ?? 3;
  const lines: string[] = [];
  let truncated = false;

  const visit = (node: unknown, path: string, depth: number): void => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const indent = '  '.repeat(depth);
    if (Array.isArray(node)) {
      lines.push(`${indent}${path}  array[${node.length}]`);
      if (depth >= maxDepth) return;
      node.slice(0, maxArrayItems).forEach((item, index) => {
        visit(item, appendIndex(path, index), depth + 1);
      });
      if (node.length > maxArrayItems) {
        lines.push(`${indent}  … ${node.length - maxArrayItems} more items`);
      }
      return;
    }
    if (isRecord(node)) {
      const keys = Object.keys(node);
      lines.push(`${indent}${path}  object{${keys.length}}`);
      if (depth >= maxDepth) return;
      for (const key of keys) visit(node[key], appendKey(path, key), depth + 1);
      return;
    }
    lines.push(`${indent}${path}  ${describeScalar(node, maxStringChars)}`);
  };

  visit(value, rootPath, 0);
  if (truncated) lines.push(`… outline truncated at ${maxLines} lines; narrow it with \`path\`.`);
  return lines.join('\n');
}

/** Compact JSON when it fits, otherwise a structure outline. */
export function previewPayload(value: unknown, maxChars: number): string {
  const json = safeStringify(value);
  if (json.length <= maxChars) return json;
  const outline = outlinePayload(value, '$', { maxDepth: 3, maxLines: 40 });
  return `(${json.length} chars; outline shown — use get_payload for content)\n${truncate(outline, maxChars)}`;
}

/** Window of `text` around a match, on a single line. */
export function snippetAround(text: string, start: number, length: number, context = 90): string {
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, start + length + context);
  return `${from > 0 ? '…' : ''}${oneLine(text.slice(from, to))}${to < text.length ? '…' : ''}`;
}
