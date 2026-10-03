import type { MappingRule, PayloadMapping } from './mapping-schema';

export type RuleChange =
  | { type: 'added'; id: string; after: MappingRule }
  | { type: 'removed'; id: string; before: MappingRule }
  | { type: 'changed'; id: string; before: MappingRule; after: MappingRule; moved: boolean }
  | { type: 'unchanged'; id: string; moved: boolean };

export type MappingDiff = {
  rules: RuleChange[];
  metadataChanged: boolean;
  usageChanged: boolean;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Rule-level diff by rule id, in the new mapping's order followed by removed rules. */
export function diffMappings(before: PayloadMapping, after: PayloadMapping): MappingDiff {
  const oldById = new Map(before.rules.map((r) => [r.id, r]));
  const newIds = new Set(after.rules.map((r) => r.id));
  // "moved" = position changed among the rules present in both versions.
  const oldCommon = before.rules.filter((r) => newIds.has(r.id)).map((r) => r.id);
  const newCommon = after.rules.filter((r) => oldById.has(r.id)).map((r) => r.id);

  const rules: RuleChange[] = after.rules.map((rule) => {
    const prev = oldById.get(rule.id);
    if (!prev) return { type: 'added', id: rule.id, after: rule };
    const moved = oldCommon.indexOf(rule.id) !== newCommon.indexOf(rule.id);
    return same(prev, rule)
      ? { type: 'unchanged', id: rule.id, moved }
      : { type: 'changed', id: rule.id, before: prev, after: rule, moved };
  });
  for (const rule of before.rules) {
    if (!newIds.has(rule.id)) rules.push({ type: 'removed', id: rule.id, before: rule });
  }
  return {
    rules,
    metadataChanged: !same(before.metadata, after.metadata),
    usageChanged: !same(before.usage, after.usage),
  };
}
