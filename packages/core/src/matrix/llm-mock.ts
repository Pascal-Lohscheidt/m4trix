import { Effect } from 'effect';

export function llmMock(): Effect.Effect<string, never, never> {
  return Effect.gen(function* () {
    const response = yield* Effect.sync(() => {
      return 'Hello, world!';
    });
    return response;
  });
}
