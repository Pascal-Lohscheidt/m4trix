/**
 * Minimal JSONPath subset used by payload mappings.
 *
 * Supported: `$` (current scope), `.key`, `['key']` / `["key"]`, `[0]`, `[-1]`, `[*]`, `.*`.
 * Paths always evaluate to a list of matches; a missing segment yields no matches.
 */

export type PathSegment =
  | { type: 'key'; key: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' };

export type ParsedPath = { ok: true; segments: PathSegment[] } | { ok: false; error: string };

const IDENT = /^[A-Za-z_$][\w$-]*/;

export function parsePath(path: string): ParsedPath {
  const src = path.trim();
  if (!src.startsWith('$')) return { ok: false, error: `Path must start with "$": ${path}` };

  const segments: PathSegment[] = [];
  let i = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '.') {
      const rest = src.slice(i + 1);
      if (rest.startsWith('*')) {
        segments.push({ type: 'wildcard' });
        i += 2;
        continue;
      }
      const m = IDENT.exec(rest);
      if (!m) return { ok: false, error: `Expected key after "." at ${i} in ${path}` };
      segments.push({ type: 'key', key: m[0] });
      i += 1 + m[0].length;
      continue;
    }
    if (ch === '[') {
      const close = findBracketClose(src, i);
      if (close < 0) return { ok: false, error: `Unclosed "[" at ${i} in ${path}` };
      const inner = src.slice(i + 1, close).trim();
      if (inner === '*') {
        segments.push({ type: 'wildcard' });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ type: 'index', index: Number(inner) });
      } else if (
        inner.length >= 2 &&
        (inner[0] === "'" || inner[0] === '"') &&
        inner[inner.length - 1] === inner[0]
      ) {
        segments.push({ type: 'key', key: inner.slice(1, -1) });
      } else {
        return { ok: false, error: `Unsupported bracket expression "[${inner}]" in ${path}` };
      }
      i = close + 1;
      continue;
    }
    return { ok: false, error: `Unexpected "${ch}" at ${i} in ${path}` };
  }
  return { ok: true, segments };
}

function findBracketClose(src: string, open: number): number {
  let quote: string | null = null;
  for (let j = open + 1; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === ']') {
      return j;
    }
  }
  return -1;
}

const parseCache = new Map<string, ParsedPath>();

function parseCached(path: string): ParsedPath {
  let parsed = parseCache.get(path);
  if (!parsed) {
    parsed = parsePath(path);
    if (parseCache.size > 2000) parseCache.clear();
    parseCache.set(path, parsed);
  }
  return parsed;
}

/** All values matched by `path` against `scope`. Invalid paths match nothing. */
export function evaluatePath(scope: unknown, path: string): unknown[] {
  const parsed = parseCached(path);
  if (!parsed.ok) return [];
  let current: unknown[] = [scope];
  for (const seg of parsed.segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value == null || typeof value !== 'object') continue;
      if (seg.type === 'key') {
        if (!Array.isArray(value) && Object.hasOwn(value, seg.key)) {
          next.push((value as Record<string, unknown>)[seg.key]);
        }
      } else if (seg.type === 'index') {
        if (Array.isArray(value)) {
          const idx = seg.index < 0 ? value.length + seg.index : seg.index;
          if (idx >= 0 && idx < value.length) next.push(value[idx]);
        }
      } else if (Array.isArray(value)) {
        next.push(...value);
      } else {
        next.push(...Object.values(value));
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current.filter((v) => v !== undefined);
}

/** First match of `path`, or `undefined`. */
export function evaluateFirst(scope: unknown, path: string): unknown {
  return evaluatePath(scope, path)[0];
}

/** True when `path` matches at least one non-null value. */
export function pathExists(scope: unknown, path: string): boolean {
  return evaluatePath(scope, path).some((v) => v !== null);
}
