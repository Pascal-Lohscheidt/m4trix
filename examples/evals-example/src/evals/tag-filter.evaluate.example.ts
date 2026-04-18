import { evaluateTagFilter, TagOrFilter } from '@m4trix/evals';

/** Small standalone example of `evaluateTagFilter` (not matched by eval discovery globs). */
export function exampleHasDemoOrPoolTag(tags: readonly string[]): boolean {
  return evaluateTagFilter(tags, TagOrFilter.of(['demo', 'pool']));
}
