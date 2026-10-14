'use client';

import { TextAlignLeftIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { DocHeading } from '@/lib/docs/source';

/** "On this page" with scroll spy: the active item is the last heading above the top third. */
export function Toc({ items }: { items: DocHeading[] }) {
  const [active, setActive] = useState<string | undefined>(items[0]?.id);

  useEffect(() => {
    const elements = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (!elements.length) return;

    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const firstVisible = elements.find((el) => visible.get(el.id));
        if (firstVisible) {
          setActive(firstVisible.id);
          return;
        }
        // Between headings: keep the last one that scrolled past the top.
        const above = elements.filter((el) => el.getBoundingClientRect().top < 120);
        if (above.length) setActive(above[above.length - 1].id);
      },
      { rootMargin: '-72px 0px -66% 0px' },
    );
    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [items]);

  if (!items.length) return null;

  return (
    <nav aria-label="On this page" className="text-[13px]">
      <p className="mb-3 flex items-center gap-2 font-medium text-text-1">
        <TextAlignLeftIcon aria-hidden className="h-3.5 w-3.5" />
        On this page
      </p>
      <ul className="docs-toc">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? 'location' : undefined}
              className={`docs-toc-link ${item.depth === 3 ? 'pl-6' : 'pl-3'} ${
                active === item.id ? 'docs-toc-link-active' : ''
              }`}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
