'use client';

import { ListIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react';
import { siGithub } from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import { Brand } from '@/components/Logo';
import { type NavTab, slugFromPathname } from '@/lib/docs/navigation';
import { GITHUB_REPO } from '@/lib/docs/site';
import { SearchButton, SearchDialog } from './SearchDialog';
import { Sidebar } from './Sidebar';
import { applyDocsMode, restoreSiteMode, ThemeToggle } from './ThemeToggle';

function ProductTabs({ tabs, active }: { tabs: NavTab[]; active: NavTab['id'] }) {
  return (
    <nav aria-label="Products" className="nav-switch">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === active ? 'page' : undefined}
          className={`nav-switch-btn ${tab.id === active ? 'nav-switch-btn-active' : ''}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Docs chrome: glass header with product tabs, sidebar, mobile drawer and ⌘K search.
 * The product of the current page sets `data-pkg`, which switches the accent color.
 */
export function DocsShell({ nav, children }: { nav: NavTab[]; children: ReactNode }) {
  const pathname = usePathname();
  const slug = slugFromPathname(pathname);
  const tab = nav.find((t) => t.groups.some((g) => g.pages.some((p) => p.slug === slug))) ?? nav[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // The docs' light/dark choice applies only while the docs are mounted (see ThemeToggle).
  useLayoutEffect(() => {
    applyDocsMode();
    return restoreSiteMode;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the drawer on navigation
  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((value) => !value);
      } else if (event.key === '/' && !(event.target as HTMLElement).closest('input, textarea')) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div data-pkg={tab.id} className="docs-root">
      <header className="glass glass-nav docs-header">
        <div className="docs-header-inner">
          <div className="flex min-w-0 items-center gap-3">
            <Brand />
            <Link href="/docs" className="docs-header-label">
              Docs
            </Link>
          </div>
          <div className="hidden justify-center lg:flex">
            <ProductTabs tabs={nav} active={tab.id} />
          </div>
          <div className="flex items-center justify-end gap-2">
            <div className="hidden md:block">
              <SearchButton onOpen={() => setSearchOpen(true)} />
            </div>
            <div className="md:hidden">
              <SearchButton compact onOpen={() => setSearchOpen(true)} />
            </div>
            <ThemeToggle />
            <a
              href={GITHUB_REPO}
              aria-label="m4trix on GitHub"
              className="docs-icon-btn docs-icon-btn-lg hidden sm:inline-flex"
            >
              <BrandIcon icon={siGithub} className="h-4 w-4" />
            </a>
            <button
              type="button"
              className="docs-icon-btn docs-icon-btn-lg lg:hidden"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={menuOpen}
              aria-controls="docs-mobile-nav"
              onClick={() => setMenuOpen((value) => !value)}
            >
              {menuOpen ? (
                <XIcon aria-hidden className="h-4 w-4" />
              ) : (
                <ListIcon aria-hidden className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </header>

      {menuOpen ? (
        <div id="docs-mobile-nav" className="docs-drawer lg:hidden">
          <ProductTabs tabs={nav} active={tab.id} />
          <div className="mt-6">
            <Sidebar tab={tab} slug={slug} />
          </div>
        </div>
      ) : null}

      <div className="docs-frame">
        <aside className="docs-sidebar" aria-label="Docs navigation">
          <Sidebar tab={tab} slug={slug} />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
