'use client';

import type { Icon } from '@phosphor-icons/react';
import { useState } from 'react';
import CodeBlock, { type CodeLanguage } from './CodeBlock';

export type CodeSample = {
  source: string;
  language: CodeLanguage;
  filename?: string;
};

export type ConceptItem = {
  id: string;
  icon: Icon;
  label: string;
  headline: string;
  body: React.ReactNode;
  bullets?: string[];
  code?: CodeSample;
};

function ConceptIcon({ icon: IconComponent }: { icon: Icon }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--accent-border) bg-(--accent-dim) text-(--accent) transition-[color,border-color,background] duration-300">
      <IconComponent aria-hidden className="h-4 w-4" weight="bold" />
    </span>
  );
}

export default function ConceptExplorer({
  items,
  ariaLabel,
  idPrefix = 'concept',
}: {
  items: ConceptItem[];
  ariaLabel: string;
  idPrefix?: string;
}) {
  const [activeId, setActiveId] = useState(items[0].id);
  const active = items.find((c) => c.id === activeId) ?? items[0];
  const ActiveIcon = active.icon;

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
      <nav
        className="flex shrink-0 flex-col gap-1 lg:w-[240px]"
        role="tablist"
        aria-label={ariaLabel}
      >
        {items.map((concept) => {
          const isActive = concept.id === activeId;
          const NavIcon = concept.icon;
          return (
            <button
              key={concept.id}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${concept.id}`}
              aria-selected={isActive}
              onClick={() => setActiveId(concept.id)}
              className={`concept-nav-btn ${isActive ? 'concept-nav-btn-active' : ''}`}
            >
              <NavIcon aria-hidden className="h-4 w-4 shrink-0" weight="bold" />
              <span className="text-left">{concept.label}</span>
            </button>
          );
        })}
      </nav>

      <div
        className="concept-detail min-w-0 flex-1"
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${active.id}`}
      >
        <div className="concept-hdr mb-4 flex items-center gap-2.5">
          <ConceptIcon icon={ActiveIcon} />
          <h3 className="font-display text-xl font-bold tracking-tight text-text-1 sm:text-2xl">
            {active.headline}
          </h3>
        </div>

        <div className="text-[15px] leading-[1.65] text-text-2">{active.body}</div>

        {active.bullets ? (
          <ul className="mt-5 space-y-2.5">
            {active.bullets.map((bullet) => (
              <li
                key={bullet}
                className="flex items-start gap-2.5 text-sm leading-relaxed text-text-2"
              >
                <span
                  className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: 'var(--accent)' }}
                />
                {bullet}
              </li>
            ))}
          </ul>
        ) : null}

        {active.code ? (
          <CodeBlock
            className="mt-6"
            code={active.code.source}
            language={active.code.language}
            filename={active.code.filename}
          />
        ) : null}
      </div>
    </div>
  );
}
