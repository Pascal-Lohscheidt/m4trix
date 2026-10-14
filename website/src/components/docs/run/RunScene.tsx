import {
  BroadcastIcon,
  CheckCircleIcon,
  PlugsConnectedIcon,
  SignInIcon,
} from '@phosphor-icons/react/dist/ssr';
import { Agent, Channel, Network, Port, Token, Wires } from 'docs-visual-gen/lib';
import type { ArrowLayout, PortKind, RunLayout } from '@/lib/docs/runs/layout';

/**
 * The network of a recorded run drawn with docs-visual-gen's components, from `layoutRun()`.
 * Stateless, so it renders on the server (`<NetworkDiagram>`) and inside the client player,
 * which passes the current step. Render it inside a docs-visual-gen `Frame`.
 */

const PORT_ICONS: Record<PortKind, typeof SignInIcon> = {
  expose: SignInIcon,
  sse: BroadcastIcon,
  custom: PlugsConnectedIcon,
};

function arrowPath({ at: { x, y }, dir }: ArrowLayout): string {
  if (dir === 'down') return `M ${x - 4.5} ${y - 3} L ${x + 4.5} ${y - 3} L ${x} ${y + 3.5} Z`;
  if (dir === 'up') return `M ${x - 4.5} ${y + 3} L ${x + 4.5} ${y + 3} L ${x} ${y - 3.5} Z`;
  return `M ${x - 3} ${y - 4.5} L ${x - 3} ${y + 4.5} L ${x + 3.5} ${y} Z`;
}

export interface RunSceneStep {
  index: number;
  /** Id prefix (page-unique) for the travel tokens the player animates. */
  idPrefix: string;
  /** Remount key for the travel tokens: one per played step. */
  nonce: number;
  /** Render travel tokens (hidden until the player's timeline shows them). */
  travel: boolean;
  /** Show the step's end state: the event resting on its channel(s). */
  settled: boolean;
  agents: string[];
  ports: string[];
}

export function travelTokenId(prefix: string, nonce: number, lane: number, branch: number) {
  return `${prefix}-t${nonce}-${lane}-${branch}`;
}

export function RunScene({ layout, step }: { layout: RunLayout; step?: RunSceneStep }) {
  const current = step ? layout.steps[step.index] : undefined;
  const litAgents = new Set(step?.agents ?? []);
  const litPorts = new Set(step?.ports ?? []);
  const tokenIcon = current?.runtime ? <CheckCircleIcon size={15} weight="fill" /> : undefined;

  return (
    <>
      <Network box={layout.network} />
      {layout.lanes.map((lane) => (
        <Channel
          key={lane.name}
          box={lane.box}
          name={lane.name}
          tone={lane.tone}
          labelEdge={lane.labelEdge}
          labelOffset={lane.labelOffset}
        />
      ))}

      <Wires paths={layout.wires} />
      <svg className="docs-run-arrows" aria-hidden="true">
        {layout.arrows.map((arrow) => (
          <path key={`${arrow.at.x},${arrow.at.y}`} d={arrowPath(arrow)} />
        ))}
      </svg>

      {/* Tokens before ports and agents, so they slide under them. */}
      {current && step?.travel
        ? current.enter.flatMap((enter, lane) =>
            [enter, ...current.branches[lane]].map((path, branch) => (
              <Token
                // biome-ignore lint/suspicious/noArrayIndexKey: paths are fixed per step
                key={`${step.nonce}-${lane}-${branch}`}
                id={travelTokenId(step.idPrefix, step.nonce, lane, branch)}
                at={path.points[0]}
                label={current.label}
                icon={tokenIcon}
                neutral={current.runtime}
              />
            )),
          )
        : null}
      {current
        ? current.rest.map((at, lane) => (
            <Token
              // biome-ignore lint/suspicious/noArrayIndexKey: one resting token per channel
              key={`rest-${step?.index}-${lane}`}
              id={`${step?.idPrefix}-rest-${lane}`}
              at={at}
              label={current.label}
              icon={tokenIcon}
              neutral={current.runtime}
              visible={step?.settled}
            />
          ))
        : null}

      {layout.ports.map((port) => {
        const Icon = PORT_ICONS[port.kind];
        return (
          <Port
            key={port.id}
            at={port.at}
            label={port.label}
            icon={<Icon size={16} weight="bold" />}
            active={litPorts.has(port.id)}
          />
        );
      })}
      {layout.agents.map((agent) => (
        <Agent
          key={agent.name}
          at={agent.at}
          name={agent.name}
          active={litAgents.has(agent.name)}
        />
      ))}
    </>
  );
}
