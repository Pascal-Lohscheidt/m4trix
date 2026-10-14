import { CheckCircle, Globe } from '@phosphor-icons/react/dist/ssr';
import { type Box, boxStyle } from './geometry';
import type { TimelineLike } from './motion';
import './client-card.css';

/**
 * Neumorphic browser that shows a prompt and the streamed answer. Lines start hidden;
 * reveal them with `revealClientLine` using `#<id>-prompt`, `#<id>-chunk-<i>`, `#<id>-done`,
 * or pass `revealed` to show every line (static use).
 */
export function ClientCard({
  id,
  box,
  prompt,
  chunks,
  doneLabel = 'run.completed',
  revealed = false,
}: {
  id: string;
  box: Box;
  prompt: string;
  chunks: string[];
  doneLabel?: string;
  revealed?: boolean;
}) {
  return (
    <div className="dv-client" id={id} style={boxStyle(box)} data-revealed={revealed || undefined}>
      <div className="dv-client-head">
        <Globe size={18} weight="duotone" color="var(--dv-ink-2)" />
        browser
      </div>
      <div className="dv-client-screen">
        <div id={`${id}-prompt`} className="dv-client-line dv-client-user">
          › {prompt}
        </div>
        <div className="dv-client-answer">
          {chunks.map((chunk, i) => (
            <span key={chunk} id={`${id}-chunk-${i}`} className="dv-client-line">
              {chunk}
            </span>
          ))}
        </div>
        <div id={`${id}-done`} className="dv-client-line dv-client-done">
          <CheckCircle size={15} weight="fill" color="var(--dv-done)" />
          {doneLabel}
        </div>
      </div>
    </div>
  );
}

export function revealClientLine(tl: TimelineLike, selector: string, at: number) {
  tl.add(selector, { opacity: [0, 1], y: [6, 0], duration: 300, ease: 'out(3)' }, at);
}

/** Fade every line out again so the loop restarts from an empty screen. */
export function clearClient(tl: TimelineLike, id: string, at: number) {
  tl.add(`#${id} .dv-client-line`, { opacity: [1, 0], duration: 400, ease: 'out(2)' }, at);
}
