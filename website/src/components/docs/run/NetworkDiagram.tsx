import { ScaledFrame } from 'docs-visual-gen/lib';
import { topologyText } from '@/lib/docs/runs/describe';
import { layoutRun } from '@/lib/docs/runs/layout';
import { loadRun } from '@/lib/docs/runs/load';
import { GraphicFrame } from '../GraphicFrame';
import { RunScene } from './RunScene';

/**
 * `<NetworkDiagram run="concepts/channels" />`: the static topology of a recorded run (channels
 * as lanes, agents where their channels meet, `expose()` and proxies on the border), laid out
 * from the recording, never by hand.
 */
export async function NetworkDiagram({ run: id }: { run: string }) {
  const run = await loadRun(id);
  const layout = layoutRun(run);
  return (
    <GraphicFrame label="network diagram" aspect={layout.width / layout.height}>
      <figure className="docs-run-figure not-prose">
        <ScaledFrame
          width={layout.width}
          height={layout.height}
          theme="auto"
          upscale
          wrapperClassName="docs-run-canvas"
          role="img"
          aria-label={`Network diagram. ${topologyText(run)}`}
        >
          <RunScene layout={layout} />
        </ScaledFrame>
      </figure>
    </GraphicFrame>
  );
}
