'use client';

import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  XIcon,
} from '@phosphor-icons/react';
import { animate, type JSAnimation } from 'animejs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type SnippetId, SNIPPET_FOR, SNIPPETS } from '@/lib/agent-run-code';
import {
  type Decision,
  endOf,
  PROMPT,
  RUNS,
  type Run,
  type RunEvent,
  reqIndex,
  pauseOf,
  SCALE,
} from '@/lib/agent-run';
import AgentRunPlane from './AgentRunPlane';
import CodeBlock from './CodeBlock';

const AUTO_APPROVE_MS = 7000;
// Replay slower than the recording so the hand-offs between agents are easy to follow.
const PLAYBACK = 0.6;

const LANES = [
  { id: 'you', label: 'you' },
  { id: 'triage', label: 'triage' },
  { id: 'logs', label: 'logs' },
  { id: 'metrics', label: 'metrics' },
  { id: 'deploys', label: 'deploys' },
  { id: 'findings', label: 'findings', note: 'aggregator' },
  { id: 'remediator', label: 'remediator' },
  { id: 'auditLog', label: 'auditLog', note: 'catch-all' },
];

const AREAS = ['logs', 'metrics', 'deploys'] as const;

type Phase = 'idle' | 'running' | 'waiting' | 'done';
type View = 'plane' | 'timeline' | 'code';

const VIEWS: { id: View; label: string }[] = [
  { id: 'plane', label: 'Event plane' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'code', label: 'Code' },
];

/* ─── Client pane: built only from what the browser receives ──────────── */

function StepIcon({ state }: { state: 'pending' | 'running' | 'done' }) {
  if (state === 'done') {
    return <CheckIcon aria-hidden className="h-3.5 w-3.5 text-success" weight="bold" />;
  }
  if (state === 'running') {
    return <CircleNotchIcon aria-hidden className="run-spin h-3.5 w-3.5 text-(--accent)" />;
  }
  return <CircleIcon aria-hidden className="h-3.5 w-3.5 text-text-4" />;
}

function ClientPane({
  events,
  phase,
  decision,
  onDecide,
  countdownRef,
}: {
  events: RunEvent[];
  phase: Phase;
  decision: Decision | null;
  onDecide: (d: Decision) => void;
  countdownRef: React.RefObject<HTMLSpanElement | null>;
}) {
  const plan = events.find((e) => e.name === 'plan');
  const steps = (plan?.payload.steps as string[] | undefined) ?? [];
  const approval = events.find((e) => e.name === 'approval-requested');
  const answer = events
    .filter((e) => e.name === 'chunk')
    .map((e) => e.payload.delta as string)
    .join('');
  const streaming = answer.length > 0 && !events.some((e) => e.name === 'answer');

  const stepState = (area: (typeof AREAS)[number]) => {
    if (events.some((e) => e.name === 'finding' && e.payload.area === area)) return 'done';
    if (events.some((e) => e.name === 'tool-call' && e.payload.area === area)) return 'running';
    return 'pending';
  };
  const finding = (area: string) =>
    events.find((e) => e.name === 'finding' && e.payload.area === area)?.payload.summary as
      | string
      | undefined;
  const tool = (area: string) =>
    events.find((e) => e.name === 'tool-call' && e.payload.area === area)?.payload.tool as
      | string
      | undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
      <p className="run-bubble self-end">{PROMPT}</p>

      {plan ? (
        <div className="run-fade flex flex-col gap-2.5">
          {AREAS.map((area, i) => {
            const state = stepState(area);
            return (
              <div key={area} className="flex min-w-0 gap-2.5">
                <span className="mt-[3px] shrink-0">
                  <StepIcon state={state} />
                </span>
                <div className="min-w-0">
                  <p
                    className={`text-[13.5px] ${state === 'pending' ? 'text-text-3' : 'text-text-1'}`}
                  >
                    {steps[i]}
                  </p>
                  {state === 'running' ? (
                    <p className="font-mono text-[11.5px] text-text-3">
                      {area} is calling {tool(area)}
                    </p>
                  ) : null}
                  {state === 'done' ? (
                    <p className="run-fade text-[12.5px] leading-snug text-text-2">
                      {finding(area)}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="run-fade font-mono text-[12px] text-text-3">triage is planning</p>
      )}

      {approval ? (
        <div className="run-fade run-approval">
          <p className="text-[13.5px] font-medium text-text-1">
            {approval.payload.action as string}?
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-text-2">
            {approval.payload.reason as string}
          </p>
          {decision ? (
            <p
              className={`mt-3 inline-flex items-center gap-1.5 font-mono text-[12px] ${decision === 'approved' ? 'text-success' : 'text-(--red)'}`}
            >
              {decision === 'approved' ? (
                <CheckIcon aria-hidden className="h-3.5 w-3.5" weight="bold" />
              ) : (
                <XIcon aria-hidden className="h-3.5 w-3.5" weight="bold" />
              )}
              {decision === 'approved' ? 'Approved by you' : 'Denied by you'}
            </p>
          ) : (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={phase !== 'waiting'}
                onClick={() => onDecide('approved')}
                className="run-btn run-btn-primary relative overflow-hidden"
              >
                <span
                  ref={countdownRef}
                  aria-hidden
                  className="absolute inset-0 origin-left bg-white/15"
                  style={{ transform: 'scaleX(0)' }}
                />
                <span className="relative">Approve</span>
              </button>
              <button
                type="button"
                disabled={phase !== 'waiting'}
                onClick={() => onDecide('denied')}
                className="run-btn"
              >
                Deny
              </button>
            </div>
          )}
        </div>
      ) : null}

      {answer ? (
        <p className="run-fade text-[13.5px] leading-relaxed text-text-1">
          {answer}
          {streaming ? <span className="console-caret ml-0.5" /> : null}
        </p>
      ) : null}
    </div>
  );
}

/* ─── Network pane: lanes and event log ───────────────────────────────── */

function Lanes({ run, awaitFrom, awaitTo }: { run: Run; awaitFrom?: number; awaitTo?: number }) {
  const pct = (ms: number) => `${(ms / SCALE) * 100}%`;
  return (
    <div className="relative">
      {LANES.map((lane) => {
        const invocations = run.invocations.filter((inv) => inv.lane === lane.id);
        const emitted = run.events.filter((e) => e.by === lane.id);
        const ticks = lane.id === 'auditLog' || lane.id === 'findings';
        return (
          <div
            key={lane.id}
            className="grid h-[1.9rem] grid-cols-[5.5rem_1fr] items-center sm:grid-cols-[6.5rem_1fr]"
          >
            <span className="flex min-w-0 flex-col pr-2 font-mono leading-tight">
              <span className="truncate text-[11.5px] text-text-2">{lane.label}</span>
              {lane.note ? (
                <span className="truncate text-[10px] text-text-4">{lane.note}</span>
              ) : null}
            </span>
            <div className="run-track">
              {invocations.map((inv) => (
                <span
                  key={`${inv.channel}-${inv.trigger}-${inv.start}`}
                  className={ticks ? 'run-tick' : 'run-bar'}
                  style={
                    {
                      left: pct(inv.start),
                      width: ticks ? undefined : pct(Math.max(inv.end - inv.start, 30)),
                      '--s': inv.start,
                      '--d': Math.max(inv.end - inv.start, 1),
                    } as React.CSSProperties
                  }
                />
              ))}
              {lane.id === 'remediator' && awaitFrom !== undefined && awaitTo !== undefined ? (
                <span
                  className="run-bar run-await"
                  style={
                    {
                      left: pct(awaitFrom),
                      width: pct(awaitTo - awaitFrom),
                      '--s': awaitFrom,
                      '--d': awaitTo - awaitFrom,
                    } as React.CSSProperties
                  }
                />
              ) : null}
              {run.spans
                .filter((span) => span.lane === lane.id)
                .map((span) => (
                  <span
                    key={`${span.name}-${span.start}`}
                    className="run-bar run-llm"
                    title={span.name}
                    style={
                      {
                        left: pct(span.start),
                        width: pct(span.end - span.start),
                        '--s': span.start,
                        '--d': span.end - span.start,
                      } as React.CSSProperties
                    }
                  />
                ))}
              {emitted.map((e) => (
                <span
                  key={e.i}
                  className="run-dot"
                  title={e.name}
                  style={{ left: pct(e.t), '--s': e.t } as React.CSSProperties}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div className="pointer-events-none absolute top-0 right-0 bottom-6 left-[5.5rem] sm:left-[6.5rem]">
        <span className="run-playhead" />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-[5.5rem] font-mono text-[10.5px] text-text-3 sm:pl-[6.5rem]">
        <span className="flex items-center gap-1.5">
          <span className="run-swatch run-swatch-invoke" /> invocation
        </span>
        <span className="flex items-center gap-1.5">
          <span className="run-swatch run-swatch-llm" /> model call
        </span>
        <span className="flex items-center gap-1.5">
          <span className="run-swatch run-swatch-await" /> awaiting you
        </span>
        <span className="flex items-center gap-1.5">
          <span className="run-swatch run-swatch-event" /> event
        </span>
      </div>
    </div>
  );
}

function EventLog({ events }: { events: RunEvent[] }) {
  const recent = events.slice(-6);
  return (
    <ol className="flex flex-col justify-end gap-1 font-mono text-[11.5px]" aria-live="off">
      {recent.map((e) => (
        <li key={e.i} className="run-fade flex min-w-0 items-baseline gap-3">
          <span className="w-11 shrink-0 text-right text-text-4 tabular-nums">
            {(e.t / 1000).toFixed(2)}s
          </span>
          <span className="w-[4.5rem] shrink-0 truncate text-text-3">{e.by}</span>
          <span className="shrink-0 text-(--accent)">{e.name}</span>
          <span className="hidden truncate text-text-4 sm:inline">
            {e.channels.join(' + ')} {JSON.stringify(e.payload)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ─── Replay ──────────────────────────────────────────────────────────── */

export default function AgentRunReplay() {
  const root = useRef<HTMLDivElement>(null);
  const clockLabel = useRef<HTMLSpanElement>(null);
  const countdown = useRef<HTMLSpanElement>(null);
  const clock = useRef({ t: 0 });
  const anim = useRef<JSAnimation | null>(null);
  const countdownAnim = useRef<JSAnimation | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [view, setView] = useState<View>('plane');
  const [snippet, setSnippet] = useState<SnippetId>('network');
  const showCode = useCallback((id: string) => {
    setSnippet(SNIPPET_FOR[id] ?? 'network');
    setView('code');
  }, []);
  const code = SNIPPETS.find((item) => item.id === snippet) ?? SNIPPETS[0];

  const run = RUNS[decision ?? 'approved'];
  const req = reqIndex(run);
  // Before a decision only the shared prefix is known: everything up to the approval request.
  const known = decision ? run.events : run.events.slice(0, req + 1);
  const visible = known.slice(0, count);
  const resolved = run.events.find((e) => e.name === 'approval-resolved');

  const paint = useCallback((events: RunEvent[]) => {
    const t = clock.current.t;
    root.current?.style.setProperty('--t', String(t));
    if (clockLabel.current) clockLabel.current.textContent = `${(t / 1000).toFixed(1)}s`;
    let n = 0;
    while (n < events.length && events[n].t <= t) n++;
    setCount((prev) => (prev === n ? prev : n));
  }, []);

  const playTo = useCallback(
    (events: RunEvent[], to: number, onDone: () => void) => {
      anim.current?.pause();
      anim.current = animate(clock.current, {
        t: to,
        duration: Math.max(0, to - clock.current.t) / PLAYBACK,
        ease: 'linear',
        onUpdate: () => paint(events),
        onComplete: () => {
          paint(events);
          onDone();
        },
      });
    },
    [paint],
  );

  const decide = useCallback(
    (choice: Decision) => {
      countdownAnim.current?.pause();
      const branch = RUNS[choice];
      // Never rewind: the prefix already played a little past the request.
      clock.current.t = Math.max(clock.current.t, branch.events[reqIndex(branch)].t);
      setDecision(choice);
      setPhase('running');
      playTo(branch.events, endOf(branch), () => setPhase('done'));
    },
    [playTo],
  );

  const start = useCallback(() => {
    countdownAnim.current?.pause();
    const prefix = RUNS.approved.events.slice(0, reqIndex(RUNS.approved) + 1);
    clock.current.t = 0;
    setDecision(null);
    setCount(0);
    paint(prefix);
    setPhase('running');
    // Stop once the approval request has reached the browser, not when it was published.
    playTo(prefix, pauseOf(RUNS.approved), () => setPhase('waiting'));
  }, [paint, playTo]);

  // Waiting on the visitor: fill the Approve button, then approve on their behalf.
  useEffect(() => {
    if (phase !== 'waiting' || !countdown.current) return;
    countdownAnim.current = animate(countdown.current, {
      scaleX: [0, 1],
      duration: AUTO_APPROVE_MS,
      ease: 'linear',
      onComplete: () => decide('approved'),
    });
    return () => {
      countdownAnim.current?.pause();
    };
  }, [phase, decide]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) {
      setReduced(true);
      setDecision('approved');
      clock.current.t = endOf(RUNS.approved);
      paint(RUNS.approved.events);
      setPhase('done');
      return;
    }
    // The event plane needs width; small screens start on the timeline.
    if (!window.matchMedia('(min-width: 640px)').matches) setView('timeline');
    const el = root.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          start();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      anim.current?.pause();
      countdownAnim.current?.pause();
    };
  }, [paint, start]);

  const status = useMemo(() => {
    if (phase === 'waiting') return 'waiting for you';
    if (phase === 'done') return decision === 'denied' ? 'done, rollback denied' : 'done';
    return 'running';
  }, [phase, decision]);

  return (
    <div
      ref={root}
      className="gfx-card console-shadow"
      style={{ '--t': 0, '--dur': SCALE } as React.CSSProperties}
    >
      <div className="flex items-center gap-3 border-b border-(--border) px-4 py-2.5 font-mono text-[12px]">
        <span className={`run-status run-status-${phase}`} aria-hidden />
        <span className="text-text-1">incident-triage</span>
        <span className="hidden text-text-3 sm:inline">{status}</span>
        <span className="ml-auto text-text-3 tabular-nums" ref={clockLabel}>
          0.0s
        </span>
        {reduced ? null : (
          <button
            type="button"
            onClick={start}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-(--border-md) px-2 py-1 text-text-2 transition hover:text-text-1 active:scale-[0.98]"
          >
            <ArrowCounterClockwiseIcon aria-hidden className="h-3.5 w-3.5" />
            Replay
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
        <div className="flex min-w-0 flex-col border-b border-(--border) lg:border-r lg:border-b-0">
          <p className="gfx-label border-b border-(--border) px-4 py-2">
            browser, reading the client channel over SSE
          </p>
          <div className="min-h-[22rem] lg:min-h-[27rem]">
            <ClientPane
              events={visible.filter((e) => e.channels.includes('client') || e.by === 'you')}
              phase={phase}
              decision={decision}
              onDecide={decide}
              countdownRef={countdown}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-col">
          <div
            className="flex items-center gap-1 border-b border-(--border) px-2 py-1.5"
            role="tablist"
            aria-label="Network views"
          >
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                onClick={() => setView(item.id)}
                className={`run-tab ${view === item.id ? 'run-tab-active' : ''}`}
              >
                {item.label}
              </button>
            ))}
            {view === 'plane' ? (
              <span className="ml-auto hidden items-center gap-3 pr-2 font-mono text-[10.5px] text-text-3 sm:flex">
                <span className="flex items-center gap-1.5">
                  <span className="plane-plug plane-plug-sub static translate-none" /> subscribes
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="plane-plug static translate-none" /> publishes
                </span>
              </span>
            ) : null}
          </div>
          <div className="h-[18rem]">
            {view === 'plane' ? (
              <div className="h-full overflow-x-auto px-4 py-3">
                <AgentRunPlane run={run} decided={decision !== null} onSelect={showCode} />
              </div>
            ) : null}
            {view === 'timeline' ? (
              <div className="h-full px-4 pt-3 pb-2">
                <Lanes
                  run={run}
                  awaitFrom={run.events[req]?.t}
                  awaitTo={decision ? resolved?.t : undefined}
                />
              </div>
            ) : null}
            {view === 'code' ? (
              <div className="flex h-full flex-col">
                <div className="flex gap-1 overflow-x-auto px-2 pt-2">
                  {SNIPPETS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={snippet === item.id}
                      onClick={() => setSnippet(item.id)}
                      className={`run-file ${snippet === item.id ? 'run-file-active' : ''}`}
                    >
                      {item.file}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  <CodeBlock
                    className="agent-code-block run-code"
                    code={code.code}
                    language="typescript"
                    filename={code.file}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <div className="mt-auto border-t border-(--border) px-4 py-3">
            <div className="h-[8.5rem] overflow-hidden">
              <EventLog events={visible} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
