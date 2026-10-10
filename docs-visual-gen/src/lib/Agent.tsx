import { Lightning } from '@phosphor-icons/react';
import type { Timeline } from 'animejs';
import { Centered, type Point } from './geometry';
import './agent.css';

/** Neumorphic agent chip. Give it an `id` to animate it with `animateAgentRun`. */
export function Agent({ at, name, id }: { at: Point; name: string; id?: string }) {
  return (
    <Centered at={at}>
      <div className="agent" id={id}>
        <div className="agent-press" />
        <div className="agent-well">
          <div className="agent-glow" />
          <Lightning size={22} weight="fill" />
        </div>
        <span className="agent-name">{name}</span>
        <div className="agent-progress" />
      </div>
    </Centered>
  );
}

/**
 * The agent's logic runs from `start` for `duration` ms: the chip presses in, the icon
 * well lights up and a progress line fills. Returns to rest by `start + duration + 400`.
 */
export function animateAgentRun(tl: Timeline, selector: string, start: number, duration: number) {
  const end = start + duration;
  tl.add(
    `${selector} .agent-press`,
    { opacity: [0, 1], duration: 250, ease: 'out(2)' },
    start - 100,
  )
    .add(`${selector} .agent-glow`, { opacity: [0, 1], duration: 300 }, start - 100)
    .add(`${selector} .agent-progress`, { scaleX: [0, 1], duration, ease: 'inOut(1.4)' }, start)
    .add(`${selector} .agent-press`, { opacity: [1, 0], duration: 300, ease: 'out(2)' }, end)
    .add(`${selector} .agent-glow`, { opacity: [1, 0], duration: 300 }, end)
    .add(`${selector} .agent-progress`, { opacity: [0.85, 0], duration: 300 }, end)
    .add(
      `${selector} .agent-progress`,
      { scaleX: [1, 0], opacity: [0, 0.85], duration: 1 },
      end + 400,
    );
}
