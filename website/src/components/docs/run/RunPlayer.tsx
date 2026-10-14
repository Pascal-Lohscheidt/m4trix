import path from 'node:path';
import type { ShikiTransformer } from 'shiki';
import { highlight } from '@/lib/docs/highlight';
import { layoutRun } from '@/lib/docs/runs/layout';
import { loadRun } from '@/lib/docs/runs/load';
import { readSnippet } from '@/lib/docs/snippets';
import { GraphicFrame } from '../GraphicFrame';
import { type PlayerCode, type PlayerStep, RunPlayerClient } from './RunPlayerClient';

/** Tags every rendered line with its line number in the snippet file (`data-line`). */
function sourceLines(lineMap: number[]): ShikiTransformer {
  return {
    name: 'docs:source-lines',
    line(node, line) {
      node.properties['data-line'] = String(lineMap[line - 1]);
    },
  };
}

/**
 * `<RunPlayer run="concepts/channels" region="agents,wiring" />`: steps through a recorded run
 * on its network diagram. With `region`, the snippet's code sits beside (wide) or below
 * (narrow) the stage and highlights the line that published the current event.
 */
export async function RunPlayer({
  run: id,
  region,
  title,
}: {
  run: string;
  /** Regions of the run's snippet to show next to the player. */
  region?: string;
  /** Code panel header. Default: the snippet's file name. */
  title?: string;
}) {
  const run = await loadRun(id);
  const layout = layoutRun(run);

  let code: PlayerCode | null = null;
  if (region !== undefined) {
    const snippet = await readSnippet(run.snippet, region);
    code = {
      title: title ?? path.basename(run.snippet),
      html: await highlight(snippet.code, snippet.lang, [sourceLines(snippet.lineMap)]),
      lines: snippet.lineMap,
    };
  }

  const steps: PlayerStep[] = await Promise.all(
    run.events.map(async (event, i) => ({
      name: event.name,
      channels: event.channels,
      by: event.by,
      line: event.line,
      caption: run.walkthrough[i],
      payloadHtml: await highlight(JSON.stringify(event.payload, null, 2) ?? 'undefined', 'json'),
    })),
  );

  return (
    <GraphicFrame label="run player">
      <RunPlayerClient layout={layout} steps={steps} code={code} />
    </GraphicFrame>
  );
}
