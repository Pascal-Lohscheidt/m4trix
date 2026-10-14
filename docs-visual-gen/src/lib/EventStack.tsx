import { EnvelopeSimple } from '@phosphor-icons/react/dist/ssr';
import { Centered, type Point } from './geometry';
import './event-stack.css';

/** Static glass event card. `depth` draws queued events peeking out behind it. */
export function EventStack({
  at,
  name,
  payload,
  depth = 2,
}: {
  at: Point;
  name: string;
  payload: string;
  depth?: number;
}) {
  const ghosts = Array.from({ length: depth }, (_, i) => depth - i);
  return (
    <Centered at={at}>
      <div className="dv-event-stack">
        {ghosts.map((level) => (
          <div
            key={level}
            className="dv-event-card dv-ghost"
            style={{
              transform: `translate(${level * 9}px, ${-level * 9}px)`,
              opacity: 0.75 - level * 0.2,
            }}
          />
        ))}
        <div className="dv-event-card" style={{ position: 'relative' }}>
          <span className="dv-event-icon">
            <EnvelopeSimple size={19} weight="fill" />
          </span>
          <span>
            <div className="dv-event-name">{name}</div>
            <div className="dv-event-payload">{payload}</div>
          </span>
        </div>
      </div>
    </Centered>
  );
}
