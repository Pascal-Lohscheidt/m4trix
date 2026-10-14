'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { NavTab } from '@/lib/docs/navigation';

export function Sidebar({ tab, slug }: { tab: NavTab; slug: string }) {
  const activeRef = useRef<HTMLAnchorElement>(null);

  // Keep the current page visible in long sidebars after navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the page changes
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [slug]);

  return (
    <nav aria-label={`${tab.label} docs`} className="flex flex-col gap-7">
      {tab.groups.map((group) => (
        <div key={group.group}>
          <p className="docs-nav-group">{group.group}</p>
          <ul className="docs-nav-list">
            {group.pages.map((page) => {
              const active = page.slug === slug;
              return (
                <li key={page.slug}>
                  <Link
                    href={page.href}
                    ref={active ? activeRef : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={`docs-nav-link ${active ? 'docs-nav-link-active' : ''}`}
                  >
                    {page.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
