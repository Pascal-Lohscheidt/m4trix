import { RetryTimeline, retryTimelineLayout, ScaledFrame } from 'docs-visual-gen/lib';
import { parseRetrySpec, retryDelays, retryMarkdown } from '@/lib/docs/retries';
import { GraphicFrame } from './GraphicFrame';

/**
 * `<RetryDiagram tool="getQuote" caller="quoteAgent" times="2" base="200" factor="2"
 * result="{ price }" />`: a tool call with `.retry()` whose attempts all fail but the last,
 * with each backoff wait drawn to scale. Mirror the options of the tool on the page.
 */
export function RetryDiagram(props: Record<string, string | undefined>) {
  const spec = parseRetrySpec((name) => props[name]);
  const delays = retryDelays(spec);
  const timeline = {
    caller: spec.caller,
    tool: spec.tool,
    attempts: [
      ...delays.map(() => ({ outcome: 'error' as const, detail: 'throws → retry' })),
      { outcome: 'ok' as const, detail: `returns ${spec.result}` },
    ],
    delays,
    result: spec.result,
    note: `retry({ times: ${spec.times}, backoff: { base: ${spec.baseMs} ms, factor: ${spec.factor} } })`,
  };
  const layout = retryTimelineLayout(timeline);
  return (
    <GraphicFrame label="retry diagram" aspect={layout.width / layout.height}>
      <figure className="docs-run-figure not-prose">
        <ScaledFrame
          width={layout.width}
          height={layout.height}
          theme="auto"
          upscale
          wrapperClassName="docs-run-canvas"
          role="img"
          aria-label={retryMarkdown(spec).replace(/`/g, '')}
        >
          <RetryTimeline {...timeline} />
        </ScaledFrame>
      </figure>
    </GraphicFrame>
  );
}
