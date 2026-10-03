import type { RunNode } from '../../types';
import { pathExists } from './json-path';
import type { MappingRule, PayloadMapping, RuleMatch } from './mapping-schema';

export type PayloadSide = 'input' | 'output';

export type MatchContext = {
  run: Pick<RunNode, 'type' | 'name' | 'metadata'>;
  side: PayloadSide;
  payload: unknown;
};

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    re = new RegExp(`^${escaped}$`, 'i');
    globCache.set(glob, re);
  }
  return re;
}

export function matchesRule(match: RuleMatch, ctx: MatchContext): boolean {
  const side = match.side ?? 'both';
  if (side !== 'both' && side !== ctx.side) return false;

  if (match.runType && match.runType.length > 0 && !match.runType.includes(ctx.run.type)) {
    return false;
  }

  if (match.name !== undefined) {
    const globs = Array.isArray(match.name) ? match.name : [match.name];
    if (!globs.some((g) => globToRegExp(g).test(ctx.run.name))) return false;
  }

  if (match.metadata) {
    const meta = ctx.run.metadata ?? {};
    for (const [key, expected] of Object.entries(match.metadata)) {
      if (meta[key] !== expected) return false;
    }
  }

  if (match.requires) {
    for (const path of match.requires) {
      if (!pathExists(ctx.payload, path)) return false;
    }
  }

  return true;
}

/** First rule (in declaration order) that matches the payload, or `null`. */
export function selectRule(mapping: PayloadMapping, ctx: MatchContext): MappingRule | null {
  for (const rule of mapping.rules) {
    if (matchesRule(rule.match, ctx)) return rule;
  }
  return null;
}
