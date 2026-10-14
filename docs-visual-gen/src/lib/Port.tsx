import type { ReactNode } from 'react';
import { Centered, type Point } from './geometry';
import type { TimelineLike } from './motion';
import './port.css';

/**
 * Boundary adapter pill (expose(), proxy.sse(), ...). Place it on the network border.
 * `active` shows the flash ring (state-driven); `animatePortFlash` pulses it on a timeline.
 */
export function Port({
  at,
  label,
  icon,
  id,
  active = false,
}: {
  at: Point;
  label: string;
  icon: ReactNode;
  id?: string;
  active?: boolean;
}) {
  return (
    <Centered at={at}>
      <div className="dv-port" id={id} data-active={active || undefined}>
        <div className="dv-port-flash" />
        <span className="dv-port-well">{icon}</span>
        {label}
      </div>
    </Centered>
  );
}

/** Brief ring when an event crosses the boundary. */
export function animatePortFlash(tl: TimelineLike, selector: string, at: number) {
  tl.add(`${selector} .dv-port-flash`, { opacity: [0, 1, 0], duration: 450 }, at);
}
