import { loadRun } from '@/lib/docs/runs/load';
import { InlineCode } from './InlineCode';

/** `<RunWalkthrough run="concepts/channels" />`: the recorded run's walkthrough, one item per event. */
export async function RunWalkthrough({ run: id }: { run: string }) {
  const run = await loadRun(id);
  return (
    <ol className="docs-run-walkthrough">
      {run.walkthrough.map((sentence, i) => (
        <li key={run.events[i].i}>
          <InlineCode text={sentence} />
        </li>
      ))}
    </ol>
  );
}
