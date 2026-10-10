import { CheckCircle, Globe } from '@phosphor-icons/react';
import type { Timeline } from 'animejs';
import { type Box, boxStyle } from './geometry';
import './client-card.css';

/**
 * Neumorphic browser that shows a prompt and the streamed answer. Lines start hidden;
 * reveal them with `revealClientLine` using `#<id>-prompt`, `#<id>-chunk-<i>`, `#<id>-done`.
 */
export function ClientCard({
  id,
  box,
  prompt,
  chunks,
  doneLabel = 'run.completed',
}: {
  id: string;
  box: Box;
  prompt: string;
  chunks: string[];
  doneLabel?: string;
}) {
  return (
    <div className="client" id={id} style={boxStyle(box)}>
      <div className="client-head">
        <Globe size={18} weight="duotone" color="var(--ink-2)" />
        browser
      </div>
      <div className="client-screen">
        <div id={`${id}-prompt`} className="client-line client-user">
          › {prompt}
        </div>
        <div className="client-answer">
          {chunks.map((chunk, i) => (
            <span key={chunk} id={`${id}-chunk-${i}`} className="client-line">
              {chunk}
            </span>
          ))}
        </div>
        <div id={`${id}-done`} className="client-line client-done">
          <CheckCircle size={15} weight="fill" color="var(--done)" />
          {doneLabel}
        </div>
      </div>
    </div>
  );
}

export function revealClientLine(tl: Timeline, selector: string, at: number) {
  tl.add(selector, { opacity: [0, 1], y: [6, 0], duration: 300, ease: 'out(3)' }, at);
}

/** Fade every line out again so the loop restarts from an empty screen. */
export function clearClient(tl: Timeline, id: string, at: number) {
  tl.add(`#${id} .client-line`, { opacity: [1, 0], duration: 400, ease: 'out(2)' }, at);
}
