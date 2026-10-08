'use client';

import { createTimeline, onScroll, utils } from 'animejs';
import { Fragment, useRef } from 'react';
import { useAnimeScope } from './useAnimeScope';

type Run = { name: string; type: 'chain' | 'tool' | 'llm' };

// Each inner array runs in parallel; outer order is execution order.
const STEPS: Run[][] = [
  [{ name: 'intake', type: 'chain' }],
  [{ name: 'plan_work', type: 'chain' }],
  [
    { name: 'documentation_search', type: 'tool' },
    { name: 'repository_search', type: 'tool' },
  ],
  [{ name: 'draft_answer', type: 'llm' }],
  [{ name: 'final_review', type: 'chain' }],
];

const RUNS = STEPS.flat();

function Connector() {
  return <div className="mx-auto h-3 w-px" style={{ background: 'var(--border-md)' }} />;
}

function RunNode({ run, step }: { run: Run; step: number }) {
  return (
    <div className="gfx-node min-w-0 flex-1" data-step={step}>
      <span className="gfx-fill" />
      <span className="gfx-tag">{run.type}</span>
      <span className="relative truncate">{run.name}</span>
      <span className="gfx-dot" />
    </div>
  );
}

export default function RecordGraphic() {
  const root = useRef<HTMLDivElement>(null);

  useAnimeScope(root, (el) => {
    const fills = el.querySelectorAll('.gfx-fill');
    const dots = el.querySelectorAll('.gfx-dot');
    const lines = el.querySelectorAll('[data-line]');
    utils.set(fills, { opacity: 0 });
    utils.set(dots, { scale: 0 });
    utils.set(lines, { opacity: 0, x: -8 });

    const tl = createTimeline({
      loop: true,
      defaults: { ease: 'out(3)' },
      autoplay: onScroll({ target: el, enter: 'bottom top', leave: 'top bottom' }),
    });

    STEPS.forEach((_, step) => {
      const stepFills = el.querySelectorAll(`[data-step="${step}"] .gfx-fill`);
      const stepDots = el.querySelectorAll(`[data-step="${step}"] .gfx-dot`);
      const stepLines = el.querySelectorAll(`[data-line="${step}"]`);
      tl.add(stepFills, { opacity: [0, 1], duration: 320 }, step === 0 ? 400 : '+=180')
        .add(stepDots, { scale: [0, 1], duration: 360 }, '+=380')
        .add(stepFills, { opacity: 0.18, duration: 420 }, '<<')
        .add(stepLines, { opacity: [0, 1], x: [-8, 0], duration: 420 }, '<<');
    });

    tl.add(fills, { opacity: 0, duration: 500 }, '+=2200')
      .add(dots, { scale: 0, duration: 400 }, '<<')
      .add(lines, { opacity: 0, duration: 400 }, '<<');
  });

  return (
    <div ref={root} className="gfx-card">
      <div className="gfx-head">
        <span className="truncate">
          graph.invoke(input, {'{'} callbacks: [<span className="text-(--accent)">tracer</span>]{' '}
          {'}'})
        </span>
      </div>
      <div className="grid md:grid-cols-[0.9fr_1.1fr]">
        <div className="flex min-w-0 flex-col p-4 sm:p-5">
          {STEPS.map((runs, step) => (
            <Fragment key={runs[0].name}>
              {step > 0 ? <Connector /> : null}
              <div className="flex gap-2">
                {runs.map((run) => (
                  <RunNode key={run.name} run={run} step={step} />
                ))}
              </div>
            </Fragment>
          ))}
        </div>
        <div className="flex min-w-0 flex-col border-t border-(--border) md:border-t-0 md:border-l">
          <p className="gfx-label border-b border-(--border) px-4 py-2.5">
            .traces/traces/f19bca0d/runs.ndjson
          </p>
          <div className="flex flex-col gap-1.5 overflow-hidden p-4 font-mono text-[11.5px] leading-relaxed sm:p-5">
            {RUNS.map((run) => {
              const step = STEPS.findIndex((runs) => runs.includes(run));
              return (
                <p key={run.name} data-line={step} className="truncate text-text-3">
                  {'{'}"name":"<span className="text-(--accent)">{run.name}</span>","type":"
                  {run.type}","status":"<span className="text-success">success</span>"{'}'}
                </p>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
