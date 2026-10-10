import { Broadcast, SignIn } from '@phosphor-icons/react';
import {
  Agent,
  animateAgentRun,
  animatePortFlash,
  Channel,
  Frame,
  Network,
  Port,
  Token,
  tokenIn,
  tokenOut,
  tokenTravel,
  Wires,
} from '../lib';
import { useSceneTimeline } from '../runtime/timeline';
import type { SceneMeta } from './manifest';

/**
 * concepts/networks.md, "Fan-Out": three agents subscribe to main and publish to client.
 * One event on main is delivered to every subscriber; each runs on its own clock and
 * its response reaches the client as soon as it is ready.
 */

const MAIN_Y = 190;
const CLIENT_Y = 400;
const START_X = 200;
const SPLIT_X = 330;
const SSE_X = 1220;
const AGENT_Y = 284;
const DELIVERED = 1650;

const agents = [
  { id: 'a', name: 'agentA', x: 520, workMs: 1100 },
  { id: 'b', name: 'agentB', x: 780, workMs: 1700 },
  { id: 'c', name: 'agentC', x: 1040, workMs: 1300 },
];

export function FanOut({ meta }: { meta: SceneMeta }) {
  if (meta.output.kind !== 'gif') throw new Error('fan-out renders as a gif');

  const root = useSceneTimeline((tl) => {
    // expose() publishes one event to main.
    animatePortFlash(tl, '#port-expose', 150);
    tokenIn(tl, '#tok-start', 200);
    tokenTravel(tl, '#tok-start', 300, { x: SPLIT_X - START_X, duration: 550 });
    tl.add('#tok-start', { opacity: [1, 0], duration: 1 }, 860);

    for (const agent of agents) {
      // Every subscriber gets its own copy of the event...
      const copy = `#tok-copy-${agent.id}`;
      tl.add(copy, { opacity: [0, 1], duration: 1 }, 850);
      tokenTravel(tl, copy, 870, { x: agent.x - SPLIT_X, duration: 650 });
      tokenOut(tl, copy, 1480, { dropY: 42 });

      // ...runs on its own clock...
      animateAgentRun(tl, `#agent-${agent.id}`, DELIVERED, agent.workMs);

      // ...and publishes to client, which streams out through proxy.sse().
      const done = DELIVERED + agent.workMs;
      const response = `#tok-resp-${agent.id}`;
      const travelMs = Math.max(320, (SSE_X - agent.x) / 0.7);
      tokenIn(tl, response, done, { fromY: -70 });
      tokenTravel(tl, response, done + 320, { x: SSE_X - agent.x, duration: travelMs });
      tokenOut(tl, response, done + 260 + travelMs);
      animatePortFlash(tl, '#port-sse', done + 260 + travelMs);
    }
  }, meta.output);

  return (
    <Frame ref={root} width={meta.width} height={meta.height}>
      <Network box={{ x: 120, y: 60, w: 1100, h: 440 }} />
      <Channel name="main" tone="sand" box={{ x: 170, y: 110, w: 1000, h: 190 }} />
      <Channel
        name="client"
        tone="mint"
        box={{ x: 170, y: 268, w: 1140, h: 186 }}
        labelEdge="bottom"
      />

      <Wires
        paths={[
          `M ${START_X} ${MAIN_Y} H ${SPLIT_X}`,
          ...agents.map(
            ({ x }) =>
              `M ${SPLIT_X} ${MAIN_Y} H ${x - 24} Q ${x} ${MAIN_Y} ${x} ${MAIN_Y + 24} V ${AGENT_Y - 40}`,
          ),
          ...agents.map(
            ({ x }) =>
              `M ${x} ${AGENT_Y + 40} V ${CLIENT_Y - 20} Q ${x} ${CLIENT_Y} ${x + 20} ${CLIENT_Y} H ${SSE_X}`,
          ),
        ]}
      />

      {/* Tokens first so they slide under ports and agents. */}
      <Token id="tok-start" at={{ x: START_X, y: MAIN_Y }} label="user-message" />
      {agents.map((agent) => (
        <Token
          key={agent.id}
          id={`tok-copy-${agent.id}`}
          at={{ x: SPLIT_X, y: MAIN_Y }}
          label="user-message"
        />
      ))}
      {agents.map((agent) => (
        <Token
          key={agent.id}
          id={`tok-resp-${agent.id}`}
          at={{ x: agent.x, y: CLIENT_Y }}
          label="response"
        />
      ))}

      <Port
        id="port-expose"
        at={{ x: 120, y: MAIN_Y }}
        label="expose()"
        icon={<SignIn size={16} weight="bold" />}
      />
      <Port
        id="port-sse"
        at={{ x: SSE_X, y: CLIENT_Y }}
        label="proxy.sse()"
        icon={<Broadcast size={16} weight="bold" />}
      />

      {agents.map((agent) => (
        <Agent
          key={agent.id}
          id={`agent-${agent.id}`}
          at={{ x: agent.x, y: AGENT_Y }}
          name={agent.name}
        />
      ))}
    </Frame>
  );
}
