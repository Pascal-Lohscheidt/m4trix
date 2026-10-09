'use client';

import { createTimeline, onScroll, stagger, utils } from 'animejs';
import { useRef } from 'react';
import { useAnimeScope } from './useAnimeScope';

// The wire format NextEndpoint writes: one SSE message per envelope on the client channel.
const FRAMES = [
  { id: 'f1', name: 'plan', payload: '{"steps":["Search checkout errors since 14:02",…]}' },
  {
    id: 'f2',
    name: 'finding',
    payload: '{"area":"logs","summary":"312 timeouts from the card API"}',
  },
  { id: 'f3', name: 'approval-requested', payload: '{"action":"Roll back deploy 4f2a1c"}' },
  { id: 'f4', name: 'chunk', payload: '{"delta":"Rolled back 4f2a1c."}' },
];

export default function SseStreamGraphic() {
  const root = useRef<HTMLDivElement>(null);

  useAnimeScope(root, (el) => {
    const frames = el.querySelectorAll('[data-frame]');
    utils.set(frames, { opacity: 0, y: 6 });

    createTimeline({
      loop: true,
      defaults: { ease: 'out(3)' },
      autoplay: onScroll({ target: el, enter: 'bottom top', leave: 'top bottom' }),
    })
      .add(frames, { opacity: [0, 1], y: [6, 0], duration: 360, delay: stagger(520) }, 500)
      .add(frames, { opacity: 0, duration: 400 }, '+=2600');
  });

  return (
    <div ref={root} className="gfx-card console-shadow h-full">
      <div className="gfx-head">
        <span className="truncate">terminal</span>
      </div>
      <div className="flex flex-col gap-4 p-4 font-mono text-[12px] leading-relaxed sm:p-5">
        <p className="text-text-2">
          <span className="text-(--accent)">$</span> curl -N localhost:3000/api/chat \
          <br />
          &nbsp;&nbsp;-d &apos;{'{'}&quot;text&quot;:&quot;Checkout p95 jumped&quot;{'}'}&apos;
        </p>
        {FRAMES.map((frame) => (
          <p key={frame.id} data-frame className="min-w-0">
            <span className="block text-text-3">
              event: <span className="text-(--accent)">{frame.name}</span>
            </span>
            <span className="block truncate text-text-3">
              data: {'{'}&quot;name&quot;:&quot;{frame.name}&quot;,&quot;payload&quot;:
              <span className="text-text-1">{frame.payload}</span>,&quot;meta&quot;:{'{…}}'}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}
