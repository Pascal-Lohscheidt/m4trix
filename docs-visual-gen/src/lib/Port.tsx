import type { Timeline } from 'animejs';
import type { ReactNode } from 'react';
import { Centered, type Point } from './geometry';
import './port.css';

/** Boundary adapter pill (expose(), proxy.sse(), ...). Place it on the network border. */
export function Port({
  at,
  label,
  icon,
  id,
}: {
  at: Point;
  label: string;
  icon: ReactNode;
  id?: string;
}) {
  return (
    <Centered at={at}>
      <div className="port" id={id}>
        <div className="port-flash" />
        <span className="port-well">{icon}</span>
        {label}
      </div>
    </Centered>
  );
}

/** Brief ring when an event crosses the boundary. */
export function animatePortFlash(tl: Timeline, selector: string, at: number) {
  tl.add(`${selector} .port-flash`, { opacity: [0, 1, 0], duration: 450 }, at);
}
