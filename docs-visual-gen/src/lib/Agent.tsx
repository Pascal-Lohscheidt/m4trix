import { Lightning } from '@phosphor-icons/react/dist/ssr';
import { Centered, type Point } from './geometry';
import type { TimelineLike } from './motion';
import './agent.css';

/**
 * Neumorphic agent chip. Give it an `id` to animate it with `animateAgentRun`, or set
 * `active` to show it pressed in and lit (state-driven, no timeline).
 */
export function Agent({
  at,
  name,
  id,
  active = false,
}: {
  at: Point;
  name: string;
  id?: string;
  active?: boolean;
}) {
  return (
    <Centered at={at}>
      <div className="dv-agent" id={id} data-active={active || undefined}>
        <div className="dv-agent-press" />
        <div className="dv-agent-well">
          <div className="dv-agent-glow" />
          <Lightning size={22} weight="fill" />
        </div>
        <span className="dv-agent-name">{name}</span>
        <div className="dv-agent-progress" />
      </div>
    </Centered>
  );
}

/**
 * The agent's logic runs from `start` for `duration` ms: the chip presses in, the icon
 * well lights up and a progress line fills. Returns to rest by `start + duration + 400`.
 */
export function animateAgentRun(
  tl: TimelineLike,
  selector: string,
  start: number,
  duration: number,
) {
  const end = start + duration;
  tl.add(
    `${selector} .dv-agent-press`,
    { opacity: [0, 1], duration: 250, ease: 'out(2)' },
    start - 100,
  )
    .add(`${selector} .dv-agent-glow`, { opacity: [0, 1], duration: 300 }, start - 100)
    .add(`${selector} .dv-agent-progress`, { scaleX: [0, 1], duration, ease: 'inOut(1.4)' }, start)
    .add(`${selector} .dv-agent-press`, { opacity: [1, 0], duration: 300, ease: 'out(2)' }, end)
    .add(`${selector} .dv-agent-glow`, { opacity: [1, 0], duration: 300 }, end)
    .add(`${selector} .dv-agent-progress`, { opacity: [0.85, 0], duration: 300 }, end)
    .add(
      `${selector} .dv-agent-progress`,
      { scaleX: [1, 0], opacity: [0, 0.85], duration: 1 },
      end + 400,
    );
}
