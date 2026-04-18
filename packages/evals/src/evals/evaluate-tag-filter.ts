import type {
  TagAndFilterExpression,
  TagAndFilterOperand,
  TagOrFilterExpression,
  TagOrFilterOperand,
} from './tag-filter.js';
import type { TagMatcher } from './types.js';

function tagsMatchMatcher(tags: readonly string[], matcher: TagMatcher): boolean {
  return tags.some((tag) => (typeof matcher === 'string' ? tag === matcher : matcher.test(tag)));
}

function evaluateAndOperand(tags: readonly string[], op: TagAndFilterOperand): boolean {
  if (typeof op === 'string' || op instanceof RegExp) {
    return tagsMatchMatcher(tags, op);
  }
  return evaluateTagFilter(tags, op);
}

function evaluateOrOperand(tags: readonly string[], op: TagOrFilterOperand): boolean {
  if (typeof op === 'string' || op instanceof RegExp) {
    return tagsMatchMatcher(tags, op);
  }
  return evaluateTagFilter(tags, op);
}

/**
 * Evaluates a nested tag filter against the tags present on a test case (or any string set).
 *
 * - **Leaf** (`string` / `RegExp`): true if some tag matches the matcher.
 * - **`kind: 'or'`** ({@link TagOrFilterExpression}): true if any operand matches; empty OR is false.
 * - **`kind: 'and'`** ({@link TagAndFilterExpression}): true if every operand matches; empty AND is true.
 */
export function evaluateTagFilter(
  tags: readonly string[],
  expr: TagOrFilterExpression | TagAndFilterExpression,
): boolean {
  if (expr.kind === 'or') {
    if (expr.operands.length === 0) {
      return false;
    }
    return expr.operands.some((op) => evaluateOrOperand(tags, op));
  }
  if (expr.operands.length === 0) {
    return true;
  }
  return expr.operands.every((op) => evaluateAndOperand(tags, op));
}
