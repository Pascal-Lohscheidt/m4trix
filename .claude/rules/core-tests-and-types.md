---
paths:
  - "packages/**/*.{ts,tsx}"
---

# Package tests and types

When changing code under `packages/`, add or update focused Vitest coverage for the behavior you touch. Prefer tests beside the implementation as `*.spec.ts`.

## Test expectations

- Cover both success and failure paths for public builders, runtime validation, and thrown invariant errors.
- Use `Effect.runSync`, `Effect.runPromise`, and `Effect.scoped` in tests instead of bypassing Effect code paths.
- For async event-plane or network behavior, assert the emitted events or calls that prove the behavior, not just that setup completed.
- Keep fixtures small and local: define test events, layers, agents, and skills in the spec that exercises them.

## Type expectations

- Use `expectTypeOf` from Vitest for important generic inference and public API contracts.
- Add type checks inside realistic callbacks when that is where inference matters, such as `logic(({ layers }) => ...)` or `define(({ input, emit }) => ...)`.
- Add dedicated type-test cases for builder results, reserved fields, callback parameter types, and return signatures.
- Prefer schema-derived types (`typeof schema.Type`) and concrete layer/event names over broad `unknown`, `any`, or manual casts.

Good patterns to mirror:

```ts
expectTypeOf(input).toEqualTypeOf(inputShape.Type);
expectTypeOf(emit).parameters.toEqualTypeOf<[typeof chunkShape.Type]>();
expectTypeOf(layerValue.config).toEqualTypeOf(layerConfigShape.Type);
```

Avoid widening types just to make tests pass. If a cast is needed, keep it at the boundary being tested and preserve strict types inside package APIs.
