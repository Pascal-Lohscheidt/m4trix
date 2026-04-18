import type { Brand } from 'effect';
import { Either, Schema } from 'effect';
import type { TagMatcher } from './types.js';

const TagMatcherSchema = Schema.Union(Schema.String, Schema.instanceOf(RegExp));

/**
 * AND expression: runtime shape plus Effect `Schema.brand("TagAndFilterExpression")` (nominal typing).
 * Construct with {@link TagAndFilter.of}; validate with {@link TagAndFilterExpressionSchema}.
 */
export type TagAndFilterExpression = {
  readonly kind: 'and';
  readonly operands: ReadonlyArray<TagMatcher | TagOrFilterExpression>;
} & Brand.Brand<'TagAndFilterExpression'>;

/**
 * OR expression: runtime shape plus Effect `Schema.brand("TagOrFilterExpression")` (nominal typing).
 * Construct with {@link TagOrFilter.of}; validate or decode with {@link TagOrFilterExpressionSchema}.
 */
export type TagOrFilterExpression = {
  readonly kind: 'or';
  readonly operands: ReadonlyArray<TagMatcher | TagAndFilterExpression>;
} & Brand.Brand<'TagOrFilterExpression'>;

/** Operand of an AND group: a leaf matcher or a nested OR group. */
export type TagAndFilterOperand = TagMatcher | TagOrFilterExpression;

/** Operand of an OR group: a leaf matcher or a nested AND group. */
export type TagOrFilterOperand = TagMatcher | TagAndFilterExpression;

/**
 * Recursive OR-group schema; decode with {@link Schema.decodeUnknownEither}(`TagOrFilterExpressionSchema`).
 * Values from {@link TagOrFilter.of} are validated, frozen, and typed as {@link TagOrFilterExpression}.
 */
export const TagOrFilterExpressionSchema = Schema.Struct({
  kind: Schema.Literal('or'),
  operands: Schema.Array(
    Schema.Union(
      TagMatcherSchema,
      Schema.suspend(() => TagAndFilterExpressionSchema),
    ),
  ),
}).pipe(Schema.brand('TagOrFilterExpression')) as unknown as Schema.Schema<TagOrFilterExpression>;

/**
 * Recursive AND-group schema; decode with {@link Schema.decodeUnknownEither}(`TagAndFilterExpressionSchema`).
 * Values from {@link TagAndFilter.of} are validated, frozen, and typed as {@link TagAndFilterExpression}.
 */
export const TagAndFilterExpressionSchema = Schema.Struct({
  kind: Schema.Literal('and'),
  operands: Schema.Array(
    Schema.Union(
      TagMatcherSchema,
      Schema.suspend(() => TagOrFilterExpressionSchema),
    ),
  ),
}).pipe(Schema.brand('TagAndFilterExpression')) as unknown as Schema.Schema<TagAndFilterExpression>;

const decodeOrUnknown = Schema.decodeUnknownSync(TagOrFilterExpressionSchema);
const decodeAndUnknown = Schema.decodeUnknownSync(TagAndFilterExpressionSchema);

const decodeOrEither = Schema.decodeUnknownEither(TagOrFilterExpressionSchema);
const decodeAndEither = Schema.decodeUnknownEither(TagAndFilterExpressionSchema);

function freezeExpression(
  expr: TagOrFilterExpression | TagAndFilterExpression,
): TagOrFilterExpression | TagAndFilterExpression {
  const frozenOperands = Object.freeze(
    expr.operands.map((op) => {
      if (typeof op === 'string' || op instanceof RegExp) {
        return op;
      }
      return freezeExpression(op);
    }),
  );
  return Object.freeze({
    ...expr,
    operands: frozenOperands,
  }) as TagOrFilterExpression | TagAndFilterExpression;
}

/** Build a frozen, schema-validated {@link TagOrFilterExpression}. */
export const TagOrFilter = {
  of(operands: ReadonlyArray<TagOrFilterOperand>): TagOrFilterExpression {
    return freezeExpression(
      decodeOrUnknown({
        kind: 'or',
        operands: [...operands],
      }),
    ) as TagOrFilterExpression;
  },
} as const;

/** Build a frozen, schema-validated {@link TagAndFilterExpression}. */
export const TagAndFilter = {
  of(operands: ReadonlyArray<TagAndFilterOperand>): TagAndFilterExpression {
    return freezeExpression(
      decodeAndUnknown({
        kind: 'and',
        operands: [...operands],
      }),
    ) as TagAndFilterExpression;
  },
} as const;

/** `true` when `value` decodes as a {@link TagOrFilterExpression} (including valid nested groups). */
export function isTagOrFilter(value: unknown): value is TagOrFilterExpression {
  return Either.isRight(decodeOrEither(value));
}

/** `true` when `value` decodes as a {@link TagAndFilterExpression} (including valid nested groups). */
export function isTagAndFilter(value: unknown): value is TagAndFilterExpression {
  return Either.isRight(decodeAndEither(value));
}
