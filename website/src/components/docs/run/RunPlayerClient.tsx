'use client';

import { CaretLeftIcon, CaretRightIcon, PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { createScope, createTimeline, type Timeline } from 'animejs';
import { ScaledFrame } from 'docs-visual-gen/lib';
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Point, RunLayout, StepLayout } from '@/lib/docs/runs/layout';
import { InlineCode } from './InlineCode';
import { RunScene, travelTokenId } from './RunScene';

export interface PlayerStep {
  name: string;
  channels: string[];
  by: string | null;
  /** Line in the snippet file that published the event. */
  line: number | null;
  /** `walkthrough[i]`: Markdown with backticked names. */
  caption: string;
  /** Highlighted JSON of the payload. */
  payloadHtml: string;
}

export interface PlayerCode {
  title: string;
  /** Highlighted code; every `.line` carries `data-line` = its line in the snippet file. */
  html: string;
  /** Source lines shown, in order. */
  lines: number[];
}

/* ─── Motion ──────────────────────────────────────────────────────────────── */

/** Canvas px per ms. */
const SPEED = 0.45;
const travelMs = (length: number) => Math.min(1300, Math.max(380, length / SPEED));
/** Hold on a settled step long enough to read its caption. */
const dwellMs = (caption: string) => Math.min(7000, Math.max(2800, caption.length * 34));
const END_PAUSE = 2600;

type Ease = (t: number) => number;
const inOut =
  (power: number): Ease =>
  (t) =>
    t < 0.5 ? (2 * t) ** power / 2 : 1 - (2 * (1 - t)) ** power / 2;

/** Time fraction at which an ease reaches `progress`. */
function invert(ease: Ease, progress: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < progress) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function pointAt(points: Point[], fraction: number): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = fraction * lengths.reduce((sum, l) => sum + l, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] ? Math.min(1, left / lengths[i]) : 1;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    left -= lengths[i];
  }
  return points[points.length - 1];
}

/** Moves a token anchor along a polyline (relative to its first point) with one ease. */
function travel(
  tl: Timeline,
  node: HTMLElement,
  points: Point[],
  at: number,
  duration: number,
  ease: Ease,
) {
  if (points.length < 2) return;
  const [origin] = points;
  const state = { p: 0 };
  tl.add(
    state,
    {
      p: [0, 1],
      duration,
      ease,
      onUpdate: () => {
        const point = pointAt(points, state.p);
        node.style.transform = `translate(${point.x - origin.x}px, ${point.y - origin.y}px)`;
      },
    },
    at,
  );
}

type Light = (kind: 'agent' | 'port', id: string) => void;

/**
 * One step: the event travels from its publisher onto its channel(s) and rests there, copies
 * go on to the agents it was delivered to (which light up) and out through proxies. Returns the
 * time at which the step's end state takes over.
 */
function buildStep(
  tl: Timeline,
  step: StepLayout,
  node: (lane: number, branch: number) => HTMLElement | null,
  light: Light,
): number {
  let end = 0;
  if (step.runtime) {
    step.enter.forEach((_, lane) => {
      const token = node(lane, 0);
      if (!token) return;
      const at = 80 + lane * 120;
      const state = { y: 12 };
      tl.add(token, { opacity: [0, 1], duration: 320, ease: 'out(2)' }, at);
      tl.add(
        state,
        {
          y: [12, 0],
          duration: 460,
          ease: 'out(3)',
          onUpdate: () => {
            token.style.transform = `translateY(${state.y}px)`;
          },
        },
        at,
      );
      end = Math.max(end, at + 460);
    });
    for (const port of step.ports) tl.call(() => light('port', port), 260);
    return end + 120;
  }

  step.enter.forEach((enter, lane) => {
    const token = node(lane, 0);
    if (!token) return;
    const ease = inOut(1.8);
    const duration = travelMs(enter.length);
    tl.add(token, { opacity: [0, 1], duration: 220, ease: 'out(2)' }, 0);
    travel(tl, token, enter.points, 100, duration, ease);
    for (const mark of enter.ports) {
      tl.call(() => light('port', mark.port), 100 + invert(ease, mark.at) * duration);
    }
    let laneEnd = 100 + duration;
    const branchStart = laneEnd + 80;
    step.branches[lane].forEach((branch, b) => {
      const copy = node(lane, b + 1);
      if (!copy) return;
      const branchEase = inOut(1.6);
      const branchDuration = travelMs(branch.length);
      const arrive = branchStart + branchDuration;
      tl.add(copy, { opacity: [0, 1], duration: 1 }, branchStart);
      travel(tl, copy, branch.points, branchStart, branchDuration, branchEase);
      tl.add(copy, { opacity: [1, 0], duration: 240, ease: 'in(2)' }, arrive - 200);
      const agent = branch.agent;
      if (agent) tl.call(() => light('agent', agent), arrive - 160);
      for (const mark of branch.ports) {
        tl.call(
          () => light('port', mark.port),
          branchStart + invert(branchEase, mark.at) * branchDuration,
        );
      }
      laneEnd = Math.max(laneEnd, arrive + 40);
    });
    end = Math.max(end, laneEnd);
  });
  return end + 160;
}

/* ─── Hooks ───────────────────────────────────────────────────────────────── */

const REDUCED = '(prefers-reduced-motion: reduce)';

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/* ─── Player ──────────────────────────────────────────────────────────────── */

type Mode = 'auto' | 'play' | 'paused';
type View = { step: number; nonce: number; animate: boolean };
type Lit = { nonce: number; agents: string[]; ports: string[] };

export function RunPlayerClient({
  layout,
  steps,
  code,
}: {
  layout: RunLayout;
  steps: PlayerStep[];
  code: PlayerCode | null;
}) {
  const idPrefix = `rp${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const total = steps.length;
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  // Step 0 at rest until the player scrolls into view, so the server render is a real frame.
  const [view, setView] = useState<View>({ step: 0, nonce: 0, animate: false });
  const [settledNonce, setSettledNonce] = useState(-1);
  const [lit, setLit] = useState<Lit>({ nonce: -1, agents: [], ports: [] });
  const [mode, setMode] = useState<Mode>('auto');
  const [inView, setInView] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const started = useRef(false);

  const settled = !view.animate || settledNonce === view.nonce;
  const current = layout.steps[view.step];
  const shown = settled
    ? current
    : lit.nonce === view.nonce
      ? lit
      : { agents: [] as string[], ports: [] as string[] };
  const event = steps[view.step];
  // Stable objects: React re-applies innerHTML whenever this prop's identity changes, which
  // would drop the highlighted line.
  const codeHtml = useMemo(() => (code ? { __html: code.html } : undefined), [code]);
  const payloadHtml = useMemo(() => ({ __html: event.payloadHtml }), [event]);

  const go = useCallback(
    (step: number, animate: boolean) => {
      setView((v) => ({
        step: Math.min(Math.max(step, 0), total - 1),
        nonce: v.nonce + 1,
        animate: animate && !reducedRef.current,
      }));
    },
    [total],
  );

  // One timeline per played step; reverting the scope drops its inline styles.
  useEffect(() => {
    if (!view.animate || !frameRef.current) return;
    const root = frameRef.current;
    const { nonce } = view;
    const light: Light = (kind, id) =>
      setLit((prev) => {
        const base = prev.nonce === nonce ? prev : { nonce, agents: [], ports: [] };
        return kind === 'agent'
          ? { ...base, agents: [...base.agents, id] }
          : { ...base, ports: [...base.ports, id] };
      });
    const scope = createScope({ root: frameRef }).add(() => {
      const tl = createTimeline({ autoplay: true });
      const node = (lane: number, branch: number) =>
        root.querySelector<HTMLElement>(`#${travelTokenId(idPrefix, nonce, lane, branch)}`);
      const end = buildStep(tl, layout.steps[view.step], node, light);
      // Hand over to the resting tokens, then hide the travelling ones a frame later.
      tl.call(() => setSettledNonce(nonce), end);
      layout.steps[view.step].enter.forEach((_, lane) => {
        const token = node(lane, 0);
        if (token) tl.add(token, { opacity: 0, duration: 1 }, end + 40);
      });
    });
    return () => scope.revert();
  }, [view, layout, idPrefix]);

  // No autoplay under reduced motion.
  useEffect(() => {
    if (reduced) setMode((m) => (m === 'auto' ? 'paused' : m));
  }, [reduced]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.6,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Autoplay waits while the reader points at or works in the player; explicit play doesn't.
  const hold = mode === 'paused' || !inView || (mode === 'auto' && (hovered || focused));

  useEffect(() => {
    if (mode !== 'auto' || hold || started.current) return;
    started.current = true;
    go(0, true);
  }, [mode, hold, go]);

  useEffect(() => {
    if (hold || !settled || (mode === 'auto' && !started.current)) return;
    const last = view.step === total - 1;
    const timer = setTimeout(
      () => go(last ? 0 : view.step + 1, true),
      dwellMs(steps[view.step].caption) + (last ? END_PAUSE : 0),
    );
    return () => clearTimeout(timer);
  }, [hold, settled, mode, view, total, steps, go]);

  // Linked code: highlight the line that published the event, scrolled into view inside the
  // panel only (never the page).
  useEffect(() => {
    const body = codeRef.current;
    const pre = body?.querySelector('pre');
    if (!body || !pre) return;
    for (const node of body.querySelectorAll('.line.highlighted')) {
      node.classList.remove('highlighted');
    }
    const line = steps[view.step].line;
    const node =
      line === null ? null : body.querySelector<HTMLElement>(`.line[data-line="${line}"]`);
    if (!node) return;
    node.classList.add('highlighted');
    const top = node.getBoundingClientRect().top - pre.getBoundingClientRect().top + pre.scrollTop;
    const height = node.getBoundingClientRect().height;
    const view_ = pre.clientHeight;
    if (top < pre.scrollTop + view_ * 0.2 || top + height > pre.scrollTop + view_ * 0.8) {
      pre.scrollTo({
        top: Math.max(0, top - view_ / 2 + height / 2),
        behavior: reducedRef.current ? 'auto' : 'smooth',
      });
    }
  }, [view.step, steps]);

  // aria-disabled instead of disabled at the ends, so a focused button keeps focus.
  const prev = () => {
    if (view.step === 0) return;
    setMode('paused');
    go(view.step - 1, true);
  };
  const next = () => {
    if (view.step === total - 1) return;
    setMode('paused');
    go(view.step + 1, true);
  };
  const toggle = () => {
    if (mode === 'paused') {
      setMode('play');
      go(view.step === total - 1 ? 0 : view.step + 1, true);
    } else {
      setMode('paused');
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    const target = { ArrowLeft: view.step - 1, ArrowRight: view.step + 1, Home: 0, End: total - 1 }[
      e.key
    ];
    if (target === undefined) return;
    e.preventDefault();
    if (target < 0 || target >= total || target === view.step) return;
    setMode('paused');
    go(target, true);
  };

  const playing = mode !== 'paused';
  const lineInCode = event.line !== null && code?.lines.includes(event.line);
  const lineNote =
    event.line === null
      ? 'runtime event'
      : lineInCode
        ? `line ${event.line}`
        : `line ${event.line}, not shown`;

  return (
    <figure
      className={`docs-run not-prose${code ? ' docs-run-has-code' : ''}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="docs-run-grid">
        <div className="docs-run-main">
          <div ref={stageRef} className="docs-run-stage">
            <ScaledFrame
              ref={frameRef}
              width={layout.width}
              height={layout.height}
              theme="auto"
              upscale
              wrapperClassName="docs-run-canvas"
              style={{ '--dv-state-transition': reduced ? '0ms' : '200ms' } as CSSProperties}
              role="img"
              aria-label={`Run diagram, step ${view.step + 1} of ${total}: ${event.name}`}
            >
              <RunScene
                layout={layout}
                step={{
                  index: view.step,
                  idPrefix,
                  nonce: view.nonce,
                  travel: view.animate && !settled,
                  settled,
                  agents: shown.agents,
                  ports: shown.ports,
                }}
              />
            </ScaledFrame>
          </div>

          {/* Arrow keys, Home and End step while one of the controls has focus. */}
          <fieldset className="docs-run-bar" aria-label="Run controls" onKeyDown={onKeyDown}>
            <div className="docs-run-buttons">
              <button
                type="button"
                className="docs-run-btn"
                onClick={prev}
                aria-disabled={view.step === 0}
                aria-label="Previous step"
                title="Previous step (←)"
              >
                <CaretLeftIcon aria-hidden weight="bold" />
              </button>
              <button
                type="button"
                className="docs-run-btn"
                onClick={toggle}
                aria-label={playing ? 'Pause' : 'Play'}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? (
                  <PauseIcon aria-hidden weight="fill" />
                ) : (
                  <PlayIcon aria-hidden weight="fill" />
                )}
              </button>
              <button
                type="button"
                className="docs-run-btn"
                onClick={next}
                aria-disabled={view.step === total - 1}
                aria-label="Next step"
                title="Next step (→)"
              >
                <CaretRightIcon aria-hidden weight="bold" />
              </button>
            </div>
            <div className="docs-run-steps">
              {steps.map((s, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are fixed per recording
                  key={i}
                  type="button"
                  className="docs-run-dot"
                  data-state={i < view.step ? 'past' : i === view.step ? 'current' : undefined}
                  aria-current={i === view.step ? 'step' : undefined}
                  aria-label={`Step ${i + 1}: ${s.name}`}
                  title={`${i + 1}. ${s.name}`}
                  onClick={() => {
                    setMode('paused');
                    go(i, true);
                  }}
                />
              ))}
            </div>
            <span className="docs-run-count">
              {view.step + 1}
              <span aria-hidden> / </span>
              <span className="sr-only"> of </span>
              {total}
            </span>
          </fieldset>

          <div className="docs-run-captions">
            {steps.map((s, i) => (
              <p
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are fixed per recording
                key={i}
                data-current={i === view.step || undefined}
                aria-hidden={i !== view.step || undefined}
              >
                <span className="docs-run-caption-num">{i + 1}.</span>{' '}
                <InlineCode text={s.caption} />
              </p>
            ))}
          </div>
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {`Step ${view.step + 1} of ${total}: ${event.caption.replace(/`/g, '')}`}
          </p>

          <details className="docs-run-payload">
            <summary>
              Payload <code>{event.name}</code>
            </summary>
            <div
              className="docs-code-body"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output of the recording
              dangerouslySetInnerHTML={payloadHtml}
            />
          </details>
        </div>

        {code ? (
          <div className="docs-run-code">
            <div className="docs-code-head">
              <span className="truncate">{code.title}</span>
              <span className="docs-run-line">{lineNote}</span>
            </div>
            <div
              ref={codeRef}
              className="docs-code-body"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output of our snippet
              dangerouslySetInnerHTML={codeHtml}
            />
          </div>
        ) : null}
      </div>
    </figure>
  );
}
