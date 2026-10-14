'use client';

import { createTimeline, onScroll, stagger, utils } from 'animejs';
import { useRef } from 'react';
import { siModelcontextprotocol } from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import { useAnimeScope } from './useAnimeScope';

type Row = {
  name: string;
  type: string;
  depth: number;
  path?: boolean;
  error?: boolean;
  hotspot?: boolean;
};

const ROWS: Row[] = [
  { name: 'tracing-example-agent', type: 'chain', depth: 0, path: true },
  { name: 'research_graph', type: 'chain', depth: 1, path: true },
  { name: 'docs_research', type: 'chain', depth: 2 },
  { name: 'documentation_search', type: 'tool', depth: 3 },
  { name: 'repo_research', type: 'chain', depth: 2, path: true },
  { name: 'repository_search', type: 'tool', depth: 3, path: true, error: true },
  { name: 'writing_graph', type: 'chain', depth: 1 },
  { name: 'draft_answer', type: 'llm', depth: 2, hotspot: true },
];

const FINDINGS = [
  { label: 'Root cause', value: 'repository_search threw TimeoutError', color: 'var(--red)' },
  { label: 'Critical path', value: 'research_graph → repository_search', color: 'var(--accent)' },
  { label: 'Token hotspot', value: 'draft_answer', color: 'var(--amber)' },
];

export default function RootCauseGraphic() {
  const root = useRef<HTMLDivElement>(null);

  useAnimeScope(root, (el) => {
    const scan = el.querySelectorAll('[data-scan]');
    const bars = el.querySelectorAll('[data-path-bar]');
    const errorMarks = el.querySelectorAll('[data-error-mark]');
    const hotMarks = el.querySelectorAll('[data-hot-mark]');
    const findings = el.querySelectorAll('[data-finding]');
    utils.set(scan, { y: '-100%', opacity: 1 });
    utils.set(bars, { scaleY: 0 });
    utils.set([...errorMarks, ...hotMarks], { opacity: 0 });
    utils.set(findings, { opacity: 0, y: 6 });

    createTimeline({
      loop: true,
      defaults: { ease: 'out(3)' },
      autoplay: onScroll({ target: el, enter: 'bottom top', leave: 'top bottom' }),
    })
      .add(scan, { y: ['-100%', '0%'], duration: 1500, ease: 'inOut(2)' }, 500)
      .add(scan, { opacity: [1, 0], duration: 300 })
      .add(errorMarks, { opacity: [0, 1], duration: 380 }, '<<')
      .add(
        bars,
        { scaleY: [0, 1], duration: 360, delay: stagger(110, { reversed: true }) },
        '+=150',
      )
      .add(hotMarks, { opacity: [0, 1], duration: 380 }, '+=150')
      .add(findings, { opacity: [0, 1], y: [6, 0], duration: 420, delay: stagger(220) }, '+=200')
      .add([...errorMarks, ...hotMarks, ...findings], { opacity: 0, duration: 450 }, '+=2600')
      .add(bars, { scaleY: 0, duration: 450 }, '<<')
      .add(scan, { y: '-100%', opacity: 1, duration: 0 });
  });

  return (
    <div ref={root} className="gfx-card">
      <div className="gfx-head">
        <BrandIcon icon={siModelcontextprotocol} className="h-3.5 w-3.5" />
        <span className="truncate">
          analyze_trace({'{'} traceId: <span className="text-(--accent)">"latest"</span> {'}'})
        </span>
      </div>

      <div className="relative overflow-hidden px-4 py-4 sm:px-5">
        <div
          data-scan
          className="pointer-events-none absolute inset-0 opacity-0"
          style={{
            background:
              'linear-gradient(to bottom, transparent 0%, transparent 82%, color-mix(in srgb, var(--accent) 22%, transparent) 99%, var(--accent) 100%)',
          }}
          aria-hidden
        />
        <ul className="relative flex flex-col gap-1">
          {ROWS.map((row) => (
            <li
              key={row.name}
              className="relative flex items-center gap-2 rounded-md py-1 pr-2 font-mono text-[11.5px]"
              style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
            >
              {row.path ? (
                <span
                  data-path-bar
                  className="absolute top-1 bottom-1 left-0 w-[3px] origin-top rounded-full"
                  style={{ background: 'var(--accent)' }}
                />
              ) : null}
              {row.error ? (
                <span
                  data-error-mark
                  className="absolute inset-0 rounded-md"
                  style={{ background: 'color-mix(in srgb, var(--red) 12%, transparent)' }}
                />
              ) : null}
              <span className="gfx-tag">{row.type}</span>
              <span
                className="relative min-w-0 truncate"
                style={{ color: row.error ? 'var(--red)' : 'var(--text-2)' }}
              >
                {row.name}
              </span>
              {row.error ? (
                <span
                  data-error-mark
                  className="gfx-badge ml-auto"
                  style={{
                    color: 'var(--red)',
                    background: 'color-mix(in srgb, var(--red) 14%, transparent)',
                  }}
                >
                  root cause
                </span>
              ) : null}
              {row.hotspot ? (
                <span
                  data-hot-mark
                  className="gfx-badge ml-auto"
                  style={{
                    color: 'var(--amber)',
                    background: 'color-mix(in srgb, var(--amber) 14%, transparent)',
                  }}
                >
                  token hotspot
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <dl className="flex flex-col gap-2 border-t border-(--border) px-4 py-4 sm:px-5">
        {FINDINGS.map((finding) => (
          <div
            key={finding.label}
            data-finding
            className="grid grid-cols-[7.5rem_1fr] gap-3 text-[13px]"
          >
            <dt style={{ color: finding.color }}>{finding.label}</dt>
            <dd className="min-w-0 truncate font-mono text-[12px] text-text-2">{finding.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
