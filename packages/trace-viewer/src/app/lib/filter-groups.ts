import type { RunNode } from '../types';

export const FILTER_GROUPS_STORAGE_KEY = 'm4trix.traceViewer.filterGroups.v1';

export type DepthOperator = 'eq' | 'lt' | 'lte' | 'gt' | 'gte';

export type FilterCondition =
  | { kind: 'regex'; pattern: string }
  | { kind: 'spanType'; value: string }
  | { kind: 'depth'; operator: DepthOperator; value: number };

export type FilterGroup = {
  id: string;
  name: string;
  conditions: FilterCondition[];
  hideEnabled: boolean;
  collapseEnabled: boolean;
};

export type RunMatchContext = {
  runId: string;
  name: string;
  type: string;
  depth: number;
};

export function tryCompileRegex(pattern: string): RegExp | null {
  if (!pattern.trim()) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function conditionMatches(condition: FilterCondition, ctx: RunMatchContext): boolean {
  switch (condition.kind) {
    case 'regex': {
      const re = tryCompileRegex(condition.pattern);
      if (!re) return false;
      return re.test(ctx.name) || re.test(ctx.runId);
    }
    case 'spanType': {
      const needle = condition.value.trim().toLowerCase();
      if (!needle) return false;
      return ctx.type.toLowerCase().includes(needle);
    }
    case 'depth': {
      const d = ctx.depth;
      const v = condition.value;
      switch (condition.operator) {
        case 'eq':
          return d === v;
        case 'lt':
          return d < v;
        case 'lte':
          return d <= v;
        case 'gt':
          return d > v;
        case 'gte':
          return d >= v;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

export function groupMatches(group: FilterGroup, ctx: RunMatchContext): boolean {
  if (group.conditions.length === 0) return false;
  return group.conditions.every((c) => conditionMatches(c, ctx));
}

export function nodeMatchesHide(groups: FilterGroup[], ctx: RunMatchContext): boolean {
  return groups.some((g) => g.hideEnabled && groupMatches(g, ctx));
}

export function nodeMatchesForceCollapse(groups: FilterGroup[], ctx: RunMatchContext): boolean {
  return groups.some((g) => g.collapseEnabled && groupMatches(g, ctx));
}

/** Hide wins: if hidden, caller should omit node. Else use force-collapse for subtree display. */
export function nodeDisplayEffect(
  groups: FilterGroup[],
  ctx: RunMatchContext,
): { hidden: boolean; forceCollapse: boolean } {
  if (nodeMatchesHide(groups, ctx)) return { hidden: true, forceCollapse: false };
  if (nodeMatchesForceCollapse(groups, ctx)) return { hidden: false, forceCollapse: true };
  return { hidden: false, forceCollapse: false };
}

export function loadFilterGroups(): FilterGroup[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FILTER_GROUPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidFilterGroup);
  } catch {
    return [];
  }
}

export function saveFilterGroups(groups: FilterGroup[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FILTER_GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // ignore quota / private mode
  }
}

function isValidFilterGroup(value: unknown): value is FilterGroup {
  if (!value || typeof value !== 'object') return false;
  const g = value as Record<string, unknown>;
  if (typeof g.id !== 'string' || typeof g.name !== 'string') return false;
  if (!Array.isArray(g.conditions)) return false;
  if (typeof g.hideEnabled !== 'boolean' || typeof g.collapseEnabled !== 'boolean') return false;
  return g.conditions.every(isValidCondition);
}

function isValidCondition(value: unknown): value is FilterCondition {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (c.kind === 'regex' && typeof c.pattern === 'string') return true;
  if (c.kind === 'spanType' && typeof c.value === 'string') return true;
  if (c.kind === 'depth' && typeof c.operator === 'string') {
    const v = c.value;
    const num = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!['eq', 'lt', 'lte', 'gt', 'gte'].includes(c.operator)) return false;
    return Number.isFinite(num);
  }
  return false;
}

export function createFilterGroupId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `fg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function validateConditionsForSave(conditions: FilterCondition[]): string | null {
  if (conditions.length === 0) return 'Add at least one condition.';
  for (const c of conditions) {
    if (c.kind === 'regex') {
      if (!c.pattern.trim()) return 'Regex pattern cannot be empty.';
      if (!tryCompileRegex(c.pattern)) return 'Invalid regex pattern.';
    }
    if (c.kind === 'spanType' && !c.value.trim()) return 'Span type cannot be empty.';
    if (c.kind === 'depth' && !Number.isFinite(c.value)) return 'Depth must be a number.';
  }
  return null;
}

export function buildMatchContext(node: RunNode, depth: number): RunMatchContext {
  return {
    runId: node.runId,
    name: node.name,
    type: node.type,
    depth,
  };
}
