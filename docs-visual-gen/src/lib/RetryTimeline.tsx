import { CheckCircle, Hourglass, Wrench, XCircle } from '@phosphor-icons/react/dist/ssr';
import { Agent } from './Agent';
import { type Box, boxStyle, Centered, type Point } from './geometry';
import { Tag } from './Tag';
import { Token } from './Token';
import { Wires } from './Wires';
import './retry-timeline.css';

/**
 * One tool call with `.retry()`: the agent calls the tool, each failed attempt is followed by
 * its backoff wait (drawn to scale, so the growth is visible), and the first attempt that
 * succeeds returns its result to the agent. Stateless; lay it out with `retryTimelineLayout`
 * and render it inside a Frame of that size.
 */
export interface RetryTimelineProps {
  caller: string;
  tool: string;
  /** In order; every attempt but the last fails. */
  attempts: Array<{ outcome: 'error' | 'ok'; detail: string }>;
  /** Wait before retry n (ms), one per failed attempt that is retried. */
  delays: number[];
  /** Label of the result token returned to the caller. */
  result: string;
  /** Footer note, e.g. the retry options. */
  note?: string;
}

const BLOCK_W = 196;
const BLOCK_H = 78;
/** Waits are drawn to scale, so a doubling backoff doubles the gap. */
const PX_PER_MS = 0.6;
const MIN_GAP = 120;
const TOP = 70;
const ROW_Y = TOP + 100;
const RETURN_Y = ROW_Y + 128;

export function retryTimelineLayout(props: RetryTimelineProps) {
  const agentAt: Point = { x: 136, y: ROW_Y };
  const boxX = 300;
  const blocks: Array<Box & { center: Point }> = [];
  const waits: Array<{ from: number; to: number; ms: number }> = [];
  let x = boxX + 40;
  props.attempts.forEach((_, i) => {
    blocks.push({
      x,
      y: ROW_Y - BLOCK_H / 2,
      w: BLOCK_W,
      h: BLOCK_H,
      center: { x: x + BLOCK_W / 2, y: ROW_Y },
    });
    x += BLOCK_W;
    if (i < props.attempts.length - 1) {
      const ms = props.delays[i] ?? 0;
      const gap = ms > 0 ? Math.max(MIN_GAP, Math.round(ms * PX_PER_MS)) : MIN_GAP;
      waits.push({ from: x, to: x + gap, ms });
      x += gap;
    }
  });
  const box: Box = { x: boxX, y: TOP, w: x + 40 - boxX, h: RETURN_Y - TOP - 34 };
  const last = blocks[blocks.length - 1];
  return {
    width: box.x + box.w + 48,
    height: RETURN_Y + 56,
    agentAt,
    box,
    blocks,
    waits,
    call: `M ${agentAt.x + 96} ${ROW_Y} H ${blocks[0].x}`,
    back: `M ${last.center.x} ${ROW_Y + BLOCK_H / 2} V ${RETURN_Y} H ${agentAt.x} V ${ROW_Y + 37}`,
    resultAt: { x: Math.round((agentAt.x + last.center.x) / 2), y: RETURN_Y } as Point,
  };
}

export function RetryTimeline(props: RetryTimelineProps) {
  const layout = retryTimelineLayout(props);
  return (
    <>
      <div className="dv-retry-box" style={boxStyle(layout.box)} />
      <Tag
        box={layout.box}
        offset={30}
        kind="tool"
        name={props.tool}
        icon={<Wrench size={15} weight="duotone" color="var(--dv-ink-2)" />}
      />
      <Wires
        paths={[
          layout.call,
          layout.back,
          ...layout.waits.map((w) => `M ${w.from} ${ROW_Y} H ${w.to}`),
        ]}
      />
      <Agent at={layout.agentAt} name={props.caller} />
      {props.attempts.map((attempt, i) => {
        const block = layout.blocks[i];
        const ok = attempt.outcome === 'ok';
        return (
          <div
            key={block.x}
            className="dv-retry-attempt"
            data-outcome={attempt.outcome}
            style={boxStyle(block)}
          >
            <span className="dv-retry-icon">
              {ok ? <CheckCircle size={22} weight="fill" /> : <XCircle size={22} weight="fill" />}
            </span>
            <span className="dv-retry-text">
              <span className="dv-retry-title">attempt {i + 1}</span>
              <span className="dv-retry-detail">{attempt.detail}</span>
            </span>
          </div>
        );
      })}
      {layout.waits.map((wait, i) => (
        <Centered key={wait.from} at={{ x: (wait.from + wait.to) / 2, y: ROW_Y - 30 }}>
          <span className="dv-retry-wait">
            <Hourglass size={13} weight="fill" />
            {wait.ms} ms
          </span>
          <span className="dv-retry-wait-n">retry {i + 1}</span>
        </Centered>
      ))}
      <Token id="dv-retry-result" at={layout.resultAt} label={props.result} visible />
      {props.note ? (
        <div
          className="dv-retry-note"
          style={{ left: layout.box.x + 40, top: layout.box.y + layout.box.h - 36 }}
        >
          {props.note}
        </div>
      ) : null}
    </>
  );
}
