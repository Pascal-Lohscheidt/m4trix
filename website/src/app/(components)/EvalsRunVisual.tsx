'use client';

import { CheckIcon, CircleNotchIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

type RowState = 'pending' | 'running' | 'pass' | 'fail';

const CASES = [
  { label: 'greeting-response', result: 'pass' as const, score: 92 },
  { label: 'ambiguous-query', result: 'pass' as const, score: 88 },
  { label: 'timeout-edge', result: 'fail' as const, score: 34 },
  { label: 'tool-selection', result: 'pass' as const, score: 91 },
] as const;

const RUN_MS = 900;
const STAGGER_MS = 350;
const HOLD_MS = 2400;
const RESET_MS = 500;

function scoreTone(score: number): 'high' | 'mid' | 'low' {
  if (score >= 80) return 'high';
  if (score >= 50) return 'mid';
  return 'low';
}

function scoreColorClass(score: number): string {
  const tone = scoreTone(score);
  if (tone === 'high') return 'text-success';
  if (tone === 'mid') return 'text-(--amber)';
  return 'text-red-400';
}

function StatusIcon({ state }: { state: RowState }) {
  if (state === 'running') {
    return (
      <CircleNotchIcon
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 animate-spin text-(--accent)"
        weight="bold"
      />
    );
  }
  if (state === 'pass') {
    return <CheckIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-success" weight="bold" />;
  }
  if (state === 'fail') {
    return <XIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-red-400" weight="bold" />;
  }
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-text-4/40"
    />
  );
}

function RowScore({ score, visible }: { score: number; visible: boolean }) {
  if (!visible) {
    return <span className="inline-block w-5 shrink-0" aria-hidden />;
  }

  return (
    <span
      className={`shrink-0 font-mono text-[10px] font-semibold tabular-nums ${scoreColorClass(score)}`}
    >
      {score}
    </span>
  );
}

function averageScores(scores: ReadonlyArray<number | null>): number {
  const resolved = scores.filter((s): s is number => s !== null);
  if (resolved.length === 0) return 0;
  return Math.round(resolved.reduce((sum, s) => sum + s, 0) / resolved.length);
}

export default function EvalsRunVisual() {
  const [rows, setRows] = useState<RowState[]>(() => CASES.map(() => 'pending'));
  const [scores, setScores] = useState<Array<number | null>>(() => CASES.map(() => null));

  const average = averageScores(scores);
  const resolvedCount = scores.filter((s) => s !== null).length;

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
      setRows(CASES.map(() => 'pending'));
      setScores(CASES.map(() => null));

      let t = 400;

      CASES.forEach((c, i) => {
        schedule(() => {
          setRows((prev) => {
            const next = [...prev];
            next[i] = 'running';
            return next;
          });
        }, t);

        schedule(() => {
          setRows((prev) => {
            const next = [...prev];
            next[i] = c.result;
            return next;
          });
          setScores((prev) => {
            const next = [...prev];
            next[i] = c.score;
            return next;
          });
        }, t + RUN_MS);

        t += RUN_MS + STAGGER_MS;
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
      <p className="mb-2.5 text-center font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-4">
        Eval run
      </p>

      <div className="flex items-center gap-1.5 rounded-md border border-(--border) bg-bg/85 px-2.5 py-1.5 font-mono text-[10px]">
        <span className="text-(--accent)">$</span>
        <span className="text-text-2">pnpm m4trix-evals run</span>
      </div>

      <ul className="mt-3 flex flex-col gap-1.5">
        {CASES.map((c, i) => {
          const active = rows[i] !== 'pending';
          return (
            <li
              key={c.label}
              className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 transition-[border-color,background,opacity] duration-300 ${
                active ? 'border-(--border) bg-bg/70 opacity-100' : 'border-transparent opacity-55'
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <StatusIcon state={rows[i]} />
                <span className="truncate font-mono text-[10px] text-text-2">{c.label}</span>
              </div>
              <RowScore score={c.score} visible={rows[i] === 'pass' || rows[i] === 'fail'} />
            </li>
          );
        })}
      </ul>

      <div className="mt-4 border-t border-(--border) pt-3">
        <div className="mb-1.5 flex items-center justify-between font-mono text-[9px]">
          <span className="text-text-4">Average</span>
          <span
            className={
              resolvedCount > 0
                ? `font-semibold tabular-nums ${scoreColorClass(average)}`
                : 'text-text-4'
            }
          >
            {resolvedCount > 0 ? average : '—'}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full border border-(--border) bg-bg/80">
          <div
            className="h-full rounded-full bg-(--accent) transition-[width] duration-500 ease-out"
            style={{ width: `${average}%` }}
          />
        </div>
      </div>
    </div>
  );
}
