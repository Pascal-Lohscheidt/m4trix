'use client';

import { createTimeline, onScroll, utils } from 'animejs';
import { useRef } from 'react';
import { useAnimeScope } from './useAnimeScope';

const RUNS = [
  { name: 'plan_work', type: 'chain', payload: '{"task":"Explain how the trace…' },
  { name: 'documentation_search', type: 'tool', payload: '{"query":"trace viewer setup…' },
  { name: 'draft_answer', type: 'llm', payload: '{"messages":[{"role":"user",…' },
];

// The run that gets "opened" in the viewer.
const OPENED = 2;

export default function SplitStorageGraphic() {
  const root = useRef<HTMLDivElement>(null);

  useAnimeScope(root, (el) => {
    const rows = el.querySelectorAll('[data-row]');
    const blobs = el.querySelectorAll('[data-blob]');
    const highlights = el.querySelectorAll('[data-open] .gfx-fill');
    const ref = el.querySelectorAll('[data-ref]');
    utils.set(rows, { opacity: 0, y: -10 });
    utils.set(blobs, { opacity: 0, y: -10 });
    utils.set(highlights, { opacity: 0 });
    utils.set(ref, { opacity: 0.35 });

    const tl = createTimeline({
      loop: true,
      defaults: { ease: 'out(3)' },
      autoplay: onScroll({ target: el, enter: 'bottom top', leave: 'top bottom' }),
    });

    RUNS.forEach((_, i) => {
      tl.add(rows[i], { opacity: [0, 1], y: [-10, 0], duration: 420 }, i === 0 ? 300 : '+=260').add(
        blobs[i],
        { opacity: [0, 1], y: [-10, 0], duration: 520 },
        '<<+=140',
      );
    });

    tl.add(highlights, { opacity: [0, 1], duration: 380 }, '+=700')
      .add(ref, { opacity: [0.35, 1], duration: 380 }, '<<')
      .add([...rows, ...blobs], { opacity: 0, duration: 450 }, '+=3400')
      .add(highlights, { opacity: 0, duration: 450 }, '<<')
      .add(ref, { opacity: 0.35, duration: 450 }, '<<');
  });

  return (
    <div ref={root} className="grid gap-3 sm:grid-cols-[1.05fr_0.95fr]">
      <div className="min-w-0">
        <p className="gfx-label mb-2.5">Structure rows (files or DynamoDB)</p>
        <div className="flex flex-col gap-1.5">
          {RUNS.map((run, i) => (
            <div
              key={run.name}
              data-row
              {...(i === OPENED ? { 'data-open': true } : {})}
              className="gfx-node py-1.5 text-[11.5px]"
            >
              {i === OPENED ? <span className="gfx-fill" /> : null}
              <span className="gfx-tag">{run.type}</span>
              <span className="relative min-w-0 truncate">{run.name}</span>
              <span
                {...(i === OPENED ? { 'data-ref': true } : {})}
                className={`relative ml-auto shrink-0 text-[10.5px] ${i === OPENED ? 'text-(--accent)' : 'text-text-4'}`}
              >
                inputRef
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        <p className="gfx-label mb-2.5">Payload blobs (files or S3)</p>
        <div className="flex flex-col gap-1.5">
          {RUNS.map((run, i) => (
            <div
              key={run.name}
              data-blob
              {...(i === OPENED ? { 'data-open': true } : {})}
              className="gfx-node flex-col items-start gap-0.5 py-1.5 text-[11px]"
            >
              {i === OPENED ? <span className="gfx-fill" /> : null}
              <span className="relative text-text-3">{run.name}/input.json</span>
              <span className="relative w-full truncate text-text-2">{run.payload}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
