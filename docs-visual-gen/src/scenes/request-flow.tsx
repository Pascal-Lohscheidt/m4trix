import { Broadcast, CheckCircle, PaperPlaneTilt, SignIn } from '@phosphor-icons/react';
import {
  Agent,
  animateAgentRun,
  animatePortFlash,
  Channel,
  ClientCard,
  clearClient,
  Frame,
  Network,
  Port,
  revealClientLine,
  Token,
  tokenIn,
  tokenOut,
  tokenTravel,
  Wires,
} from '../lib';
import { useSceneTimeline } from '../runtime/timeline';
import type { SceneMeta } from './manifest';

/**
 * getting-started/whats-happening.md: one request through the hello-world network.
 *
 * POST → expose() → user-request on main → myAgent runs → agent-response chunks on client
 * → proxy.sse() → browser, closed by m4trix:run.completed.
 */

const MAIN_Y = 190;
const CLIENT_Y = 400;
const PORT_X = 420;
const AGENT = { x: 1110, y: 274 };
const BROWSER_EDGE = 250;
const CHUNKS = ['You asked:', ' what is', ' m4trix?'];

export function RequestFlow({ meta }: { meta: SceneMeta }) {
  if (meta.output.kind !== 'gif') throw new Error('request-flow renders as a gif');

  const root = useSceneTimeline((tl) => {
    // The browser sends the request; expose() turns it into a start event on main.
    revealClientLine(tl, '#browser-prompt', 150);
    tokenIn(tl, '#tok-req', 500);
    tokenTravel(tl, '#tok-req', 650, { x: 70, duration: 500 });
    tokenOut(tl, '#tok-req', 1150);
    animatePortFlash(tl, '#port-expose', 1150);

    tokenIn(tl, '#tok-start', 1450);
    tokenTravel(tl, '#tok-start', 1550, { x: 420, duration: 900 });
    tokenOut(tl, '#tok-start', 2400);
    animateAgentRun(tl, '#agent', 2550, 2150);

    // Emitted events stream over client and leave through proxy.sse() into the browser.
    const stream = (token: string, start: number, line: string) => {
      tokenIn(tl, token, start, { fromY: -70 });
      tokenTravel(tl, token, start + 320, { x: PORT_X + 30 - AGENT.x, duration: 1100 });
      tokenOut(tl, token, start + 1380);
      animatePortFlash(tl, '#port-sse', start + 1380);
      revealClientLine(tl, line, start + 1550);
    };
    for (let i = 0; i < CHUNKS.length; i++) {
      stream(`#tok-chunk-${i}`, 2900 + i * 520, `#browser-chunk-${i}`);
    }
    stream('#tok-done', 4850, '#browser-done');

    clearClient(tl, 'browser', 7000);
  }, meta.output);

  return (
    <Frame ref={root} width={meta.width} height={meta.height}>
      <Network box={{ x: PORT_X, y: 70, w: 880, h: 480 }} />
      <Channel name="main" tone="sand" box={{ x: 470, y: 115, w: 780, h: 175 }} />
      <Channel
        name="client"
        tone="mint"
        box={{ x: 470, y: 258, w: 780, h: 240 }}
        labelEdge="bottom"
      />

      <Wires
        paths={[
          `M ${BROWSER_EDGE} ${MAIN_Y} H 360`,
          `M 360 ${CLIENT_Y} H ${BROWSER_EDGE}`,
          `M 500 ${MAIN_Y} H 1000`,
          `M ${AGENT.x} 316 V ${CLIENT_Y - 20} Q ${AGENT.x} ${CLIENT_Y} ${AGENT.x - 20} ${CLIENT_Y} H 500`,
        ]}
      />

      <ClientCard
        id="browser"
        box={{ x: 40, y: 140, w: BROWSER_EDGE - 40, h: 310 }}
        prompt="what is m4trix?"
        chunks={CHUNKS}
      />

      {/* Tokens first so they slide under ports and agents. */}
      <Token
        id="tok-req"
        at={{ x: 305, y: MAIN_Y }}
        label="POST"
        neutral
        icon={<PaperPlaneTilt size={13} weight="fill" />}
      />
      <Token id="tok-start" at={{ x: 560, y: MAIN_Y }} label="user-request" />
      {CHUNKS.map((chunk, i) => (
        <Token
          key={chunk}
          id={`tok-chunk-${i}`}
          at={{ x: AGENT.x, y: CLIENT_Y }}
          label="agent-response"
        />
      ))}
      <Token
        id="tok-done"
        at={{ x: AGENT.x, y: CLIENT_Y }}
        label="m4trix:run.completed"
        neutral
        icon={<CheckCircle size={14} weight="fill" />}
      />

      <Port
        id="port-expose"
        at={{ x: PORT_X, y: MAIN_Y }}
        label="expose()"
        icon={<SignIn size={16} weight="bold" />}
      />
      <Port
        id="port-sse"
        at={{ x: PORT_X, y: CLIENT_Y }}
        label="proxy.sse()"
        icon={<Broadcast size={16} weight="bold" />}
      />

      <Agent id="agent" at={AGENT} name="myAgent" />
    </Frame>
  );
}
