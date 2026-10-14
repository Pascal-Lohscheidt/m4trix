import { S, Tool } from '@m4trix/core/matrix';

declare function fetchPrice(symbol: string, signal: AbortSignal): Promise<number>;

// #region tool
export const getQuote = Tool.of({ name: 'getQuote', description: 'Latest price for a symbol.' })
  .input(S.Struct({ symbol: S.String }))
  .output(S.Struct({ price: S.Number }))
  .timeout('2 seconds') // per attempt; a timed-out attempt is not retried
  .retry({ times: 2, backoff: { base: '200 millis', factor: 2, max: '2 seconds' } })
  .define(async ({ input, signal }) => ({ price: await fetchPrice(input.symbol, signal) }));
// #endregion tool
