import { EnvelopeSimple } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';
import type { Point } from './geometry';
import type { TimelineLike } from './motion';
import './token.css';

/**
 * An event in motion. Starts invisible at `at`. The timeline moves the zero-size anchor
 * (x / y / scale / opacity), so the pill stays centered on its path.
 */
export function Token({
  id,
  at,
  label,
  icon,
  neutral = false,
  visible = false,
}: {
  id: string;
  at: Point;
  label: string;
  icon?: ReactNode;
  neutral?: boolean;
  /** Show it without a timeline (static diagrams, state-driven players). */
  visible?: boolean;
}) {
  return (
    <div
      id={id}
      className="dv-token-anchor"
      style={{ left: at.x, top: at.y }}
      data-visible={visible || undefined}
    >
      <div className={neutral ? 'dv-token dv-neutral' : 'dv-token'}>
        <span className="dv-token-icon">{icon ?? <EnvelopeSimple size={14} weight="fill" />}</span>
        {label}
      </div>
    </div>
  );
}

const TRAVEL_EASE = 'inOut(2.4)';

/** Pop in at the anchor. `fromY` slides it in vertically (e.g. emerging from an agent). */
export function tokenIn(tl: TimelineLike, selector: string, at: number, { fromY = 0 } = {}) {
  tl.add(
    selector,
    fromY
      ? { opacity: [0, 1], y: [fromY, 0], duration: 320, ease: 'out(3)' }
      : { opacity: [0, 1], scale: [0.8, 1], duration: 250, ease: 'out(3)' },
    at,
  );
}

/** Travel along one axis, relative to the anchor. */
export function tokenTravel(
  tl: TimelineLike,
  selector: string,
  at: number,
  { x, y, duration }: { x?: number; y?: number; duration: number },
) {
  tl.add(
    selector,
    {
      ...(x !== undefined && { x: [0, x] }),
      ...(y !== undefined && { y: [0, y] }),
      duration,
      ease: TRAVEL_EASE,
    },
    at,
  );
}

/** Get absorbed by whatever it arrived at. `dropY` nudges it into a target below. */
export function tokenOut(
  tl: TimelineLike,
  selector: string,
  at: number,
  { dropY }: { dropY?: number } = {},
) {
  tl.add(
    selector,
    {
      opacity: [1, 0],
      scale: [1, 0.65],
      ...(dropY !== undefined && { y: [0, dropY] }),
      duration: 200,
      ease: 'in(2)',
    },
    at,
  );
}
