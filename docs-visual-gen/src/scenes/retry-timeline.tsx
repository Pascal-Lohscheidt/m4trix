import { Frame, RetryTimeline, type RetryTimelineProps, retryTimelineLayout } from '../lib';
import type { SceneProps } from './manifest';

/** guides/patterns.md, Retries: a tool call that succeeds on its third attempt. */
export const retryExample: RetryTimelineProps = {
  caller: 'quoteAgent',
  tool: 'getQuote',
  attempts: [
    { outcome: 'error', detail: 'throws: 503' },
    { outcome: 'error', detail: 'throws: 503' },
    { outcome: 'ok', detail: 'returns { price }' },
  ],
  delays: [200, 400],
  result: '{ price: 101.4 }',
  note: 'retry({ times: 2, backoff: { base: 200 ms, factor: 2 } })',
};

export function RetryTimelineScene({ theme }: SceneProps) {
  const layout = retryTimelineLayout(retryExample);
  return (
    <Frame width={layout.width} height={layout.height} theme={theme}>
      <RetryTimeline {...retryExample} />
    </Frame>
  );
}
