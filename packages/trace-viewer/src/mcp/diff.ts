import { appendIndex, appendKey, isRecord, oneLine, safeStringify, truncate } from './json-utils';

export type JsonChange =
  | { kind: 'added'; path: string; after: unknown }
  | { kind: 'removed'; path: string; before: unknown }
  | { kind: 'changed'; path: string; before: unknown; after: unknown };

/** Structural diff; arrays compare index by index. Stops collecting after `maxChanges`. */
export function diffJson(
  before: unknown,
  after: unknown,
  maxChanges = 200,
): { changes: JsonChange[]; truncated: boolean } {
  const changes: JsonChange[] = [];
  let truncated = false;

  const push = (change: JsonChange): boolean => {
    if (changes.length >= maxChanges) {
      truncated = true;
      return false;
    }
    changes.push(change);
    return true;
  };

  const visit = (left: unknown, right: unknown, path: string): void => {
    if (truncated) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let i = 0; i < length && !truncated; i++) {
        const childPath = appendIndex(path, i);
        if (i >= left.length) push({ kind: 'added', path: childPath, after: right[i] });
        else if (i >= right.length) push({ kind: 'removed', path: childPath, before: left[i] });
        else visit(left[i], right[i], childPath);
      }
      return;
    }
    if (isRecord(left) && isRecord(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        if (truncated) return;
        const childPath = appendKey(path, key);
        if (!Object.hasOwn(left, key)) push({ kind: 'added', path: childPath, after: right[key] });
        else if (!Object.hasOwn(right, key))
          push({ kind: 'removed', path: childPath, before: left[key] });
        else visit(left[key], right[key], childPath);
      }
      return;
    }
    if (!Object.is(left, right) && safeStringify(left) !== safeStringify(right)) {
      push({ kind: 'changed', path, before: left, after: right });
    }
  };

  visit(before, after, '$');
  return { changes, truncated };
}

function brief(value: unknown, maxChars: number): string {
  return truncate(oneLine(safeStringify(value)), maxChars);
}

export function formatJsonChanges(changes: JsonChange[], maxValueChars = 200): string {
  return changes
    .map((change) => {
      switch (change.kind) {
        case 'added':
          return `+ ${change.path}: ${brief(change.after, maxValueChars)}`;
        case 'removed':
          return `- ${change.path}: ${brief(change.before, maxValueChars)}`;
        default:
          return `~ ${change.path}: ${brief(change.before, maxValueChars)} → ${brief(change.after, maxValueChars)}`;
      }
    })
    .join('\n');
}
