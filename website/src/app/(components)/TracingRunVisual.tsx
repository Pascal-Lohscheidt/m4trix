'use client';

import { useEffect, useState } from 'react';

type RowPhase = 'hidden' | 'visible';

const TRACE = {
  name: 'research_agent',
  traceId: 'a1b2c3d4',
} as const;

const ROOT = {
  name: 'research_agent',
  type: 'chain',
  latency: '2.4s',
} as const;

const CHILDREN = [
  { id: 'llm', name: 'ChatOpenAI', type: 'llm', latency: '840ms', error: false },
  { id: 'tool', name: 'search_docs', type: 'tool', latency: '320ms', error: true },
  { id: 'format', name: 'format_response', type: 'chain', latency: '180ms', error: false },
] as const;

const REVEAL_MS = 650;
const STAGGER_MS = 220;
const HOLD_MS = 2800;
const RESET_MS = 500;

const spanRowClass =
  'grid grid-cols-[2.75rem_minmax(0,1fr)_2.5rem] items-center gap-2 rounded-md bg-bg/30 px-2 py-1.5 font-mono text-[10px]';

function SpanRow({
  type,
  name,
  latency,
  error = false,
}: {
  type: string;
  name: string;
  latency: string;
  error?: boolean;
}) {
  return (
    <div className={spanRowClass}>
      <span className="truncate text-text-4">{type}</span>
      <span className={`truncate text-text-2 ${error ? 'text-red-400' : ''}`}>{name}</span>
      <span className="text-right tabular-nums text-text-4">{latency}</span>
    </div>
  );
}

export default function TracingRunVisual() {
  const [rootPhase, setRootPhase] = useState<RowPhase>('hidden');
  const [childPhases, setChildPhases] = useState<RowPhase[]>(() => CHILDREN.map(() => 'hidden'));

  const visibleChildren = childPhases.filter((p) => p === 'visible').length;
  const totalVisible = (rootPhase === 'visible' ? 1 : 0) + visibleChildren;
  const complete = rootPhase === 'visible' && visibleChildren === CHILDREN.length;

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const schedule = (fn: () => void, ms: number) => {
      timers.push(
        setTimeout(() => {
          if (!cancelled) fn();
        }, ms),
      );
    };

    const runCycle = () => {
      setRootPhase('hidden');
      setChildPhases(CHILDREN.map(() => 'hidden'));

      let t = 400;

      schedule(() => setRootPhase('visible'), t);
      t += REVEAL_MS + STAGGER_MS;

      CHILDREN.forEach((_, i) => {
        schedule(() => {
          setChildPhases((prev) => {
            const next = [...prev];
            next[i] = 'visible';
            return next;
          });
        }, t);
        t += REVEAL_MS + STAGGER_MS;
      });

      schedule(runCycle, t + HOLD_MS + RESET_MS);
    };

    runCycle();

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="diagram-card">
      <div className="border-b border-(--border) pb-3">
        <p className="truncate font-display text-[13px] font-semibold text-text-1">{TRACE.name}</p>
        <p className="mt-1 font-mono text-[10px] text-text-4">
          {totalVisible > 0 ? (
            <>
              <span className={complete ? 'text-success' : 'text-text-3'}>
                {complete ? 'success' : 'running'}
              </span>
              {' · '}
              {totalVisible} runs · 2.4s
            </>
          ) : (
            'loading trace…'
          )}
        </p>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        {rootPhase === 'visible' ? (
          <SpanRow type={ROOT.type} name={ROOT.name} latency={ROOT.latency} />
        ) : null}

        {visibleChildren > 0 ? (
          <div className="ml-2 flex flex-col gap-1 border-l border-(--border-md) pl-2.5">
            {CHILDREN.map((span, i) =>
              childPhases[i] === 'visible' ? (
                <SpanRow
                  key={span.id}
                  type={span.type}
                  name={span.name}
                  latency={span.latency}
                  error={span.error}
                />
              ) : null,
            )}
          </div>
        ) : null}
      </div>

      <p className="mt-3 truncate border-t border-(--border) pt-2.5 font-mono text-[9px] text-text-4">
        ./.traces/traces/{TRACE.traceId}
      </p>
    </div>
  );
}
