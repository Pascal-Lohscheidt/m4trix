import type { DocsRun } from './types';

/**
 * Text equivalents of the run visuals: the `.md` output of `<NetworkDiagram>` and
 * `<RunPlayer>` / `<RunWalkthrough>`, and the diagram's accessible description.
 * Pure, so client and server code can share it.
 */

const code = (name: string) => `\`${name}\``;

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One Markdown bullet per channel and agent, in the order the network declares them. */
export function topologyMarkdown(run: DocsRun): string {
  const { topology } = run;
  const lines = ['Topology of this network, generated from the recorded run:', ''];
  for (const channel of topology.channels) {
    const main = channel.name === topology.mainChannel ? ' (the main channel)' : '';
    const carries = channel.events
      ? `carries only ${list(channel.events.map(code))}`
      : 'carries every event';
    const proxies = channel.proxies.length
      ? `; leaves the network through ${channel.proxies.length > 1 ? '' : 'an '}${list(channel.proxies.map(code))} ${channel.proxies.length > 1 ? 'proxies' : 'proxy'}`
      : '';
    lines.push(`- Channel ${code(channel.name)}${main}: ${carries}${proxies}.`);
  }
  for (const agent of topology.agents) {
    const from = agent.subscribes.length ? list(agent.subscribes.map(code)) : 'nothing';
    const to = agent.publishesTo.length
      ? `publishes to ${list(agent.publishesTo.map(code))}`
      : 'publishes nowhere';
    const listens = agent.listensTo
      ? `listens to ${list(agent.listensTo.map(code))}`
      : 'catch-all (no `listensTo`): receives every event on its channels';
    const emits = agent.emits?.length ? `, emits ${list(agent.emits.map(code))}` : '';
    lines.push(`- Agent ${code(agent.name)}: subscribes to ${from} → ${to}; ${listens}${emits}.`);
  }
  if (topology.terminalEvents.length) {
    lines.push(`- The run ends on ${list(topology.terminalEvents.map(code))} (\`endsOn\`).`);
  }
  return lines.join('\n');
}

/** Plain-text description for the diagram's `aria-label`. */
export function topologyText(run: DocsRun): string {
  return topologyMarkdown(run)
    .split('\n')
    .slice(2)
    .map((line) => line.replace(/^- /, '').replace(/`/g, ''))
    .join(' ');
}

/** The run's walkthrough as a numbered Markdown list. */
export function walkthroughMarkdown(run: DocsRun): string {
  return run.walkthrough.map((sentence, i) => `${i + 1}. ${sentence}`).join('\n');
}
