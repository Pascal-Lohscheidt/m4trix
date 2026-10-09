'use client';

import { ListIcon, MoonIcon, SunIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { siGithub } from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import { Brand } from '@/components/Logo';
import { DEFAULT_PACKAGE, isPackageId, type PackageId, PKG_NAV_META, TABS } from '@/lib/packages';
import MatrixRain from './MatrixRain';
import PackagePanel from './PackageTabs';

const GITHUB_HREF = 'https://github.com/Pascal-Lohscheidt/m4trix';

function ModeToggle() {
  const [mode, setMode] = useState<'dark' | 'light'>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const current =
      document.documentElement.getAttribute('data-mode') === 'light' ? 'light' : 'dark';
    setMode(current);
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-8 w-8" aria-hidden />;
  }

  const next = mode === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-(--border-md) text-text-3 transition hover:text-text-1"
      aria-label={`Switch to ${next} mode`}
      onClick={() => {
        setMode(next);
        document.documentElement.setAttribute('data-mode', next);
      }}
    >
      {mode === 'dark' ? (
        <SunIcon aria-hidden className="h-4 w-4" />
      ) : (
        <MoonIcon aria-hidden className="h-4 w-4" />
      )}
    </button>
  );
}

function ProductSwitch({
  active,
  onChange,
  className = '',
}: {
  active: PackageId;
  onChange: (pkg: PackageId) => void;
  className?: string;
}) {
  return (
    <div className={`nav-switch ${className}`.trim()} role="tablist" aria-label="Packages">
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`panel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={`nav-switch-btn flex-1 justify-center ${isActive ? 'nav-switch-btn-active' : ''}`}
          >
            {tab.label}
            {tab.badge ? (
              <span className="hidden text-[10px] opacity-70 lg:inline">{tab.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function SiteNav({
  activePkg,
  onChange,
}: {
  activePkg: PackageId;
  onChange: (pkg: PackageId) => void;
}) {
  const meta = PKG_NAV_META[activePkg];
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav
      className="glass glass-nav sticky top-0 z-50 border-b transition-[border-color,background] duration-300"
      style={{
        borderColor: 'var(--border)',
      }}
    >
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="mx-auto grid h-16 max-w-6xl grid-cols-[1fr_auto] items-center gap-4 md:grid-cols-[1fr_auto_1fr]">
          <Brand />
          <ProductSwitch active={activePkg} onChange={onChange} className="hidden md:flex" />
          <div className="hidden items-center justify-end gap-2 md:flex">
            <ModeToggle />
            <a
              href={GITHUB_HREF}
              aria-label="m4trix on GitHub"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-(--border-md) text-text-3 transition hover:text-text-1"
            >
              <BrandIcon icon={siGithub} className="h-4 w-4" />
            </a>
            <a href={meta.docsHref} className="btn-nav-docs h-8 px-3.5 text-[12px]">
              {meta.docsLabel}
            </a>
          </div>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center justify-self-end rounded-md border border-(--border-md) text-text-2 transition md:hidden"
            aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <XIcon aria-hidden className="h-[18px] w-[18px]" />
            ) : (
              <ListIcon aria-hidden className="h-[18px] w-[18px]" />
            )}
          </button>
        </div>
      </div>
      {menuOpen ? (
        <div
          id="mobile-nav-menu"
          className="flex flex-col gap-3 border-t px-4 py-4 md:hidden"
          style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
        >
          <ProductSwitch
            active={activePkg}
            onChange={(pkg) => {
              onChange(pkg);
              setMenuOpen(false);
            }}
            className="w-full"
          />
          <div className="flex items-center gap-2">
            <ModeToggle />
            <a href={GITHUB_HREF} className="btn-nav-ghost h-8 flex-1 justify-center">
              <BrandIcon icon={siGithub} className="h-3.5 w-3.5" />
              GitHub
            </a>
            <a href={meta.docsHref} className="btn-nav-docs h-8 flex-1 justify-center">
              {meta.docsLabel}
            </a>
          </div>
        </div>
      ) : null}
    </nav>
  );
}

function SiteFooter() {
  return (
    <footer
      className="relative z-10 border-t transition-[border-color,background] duration-300"
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
    >
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 py-8 text-sm text-text-3 sm:flex-row sm:items-center sm:justify-between">
          <p>MIT licensed. Built by Pascal Lohscheidt.</p>
          <div className="flex items-center gap-6">
            <a href="https://docs.m4trix.dev" className="transition-colors hover:text-text-1">
              Docs
            </a>
            <a
              href="https://www.npmjs.com/package/@m4trix/tracing"
              className="transition-colors hover:text-text-1"
            >
              npm
            </a>
            <a href={GITHUB_HREF} className="transition-colors hover:text-text-1">
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

function readHashPackage(): PackageId {
  const hash = window.location.hash.replace('#', '');
  return isPackageId(hash) ? hash : DEFAULT_PACKAGE;
}

export default function LandingPage() {
  const [activePkg, setActivePkg] = useState<PackageId>(DEFAULT_PACKAGE);

  useEffect(() => {
    setActivePkg(readHashPackage());
    const onHashChange = () => setActivePkg(readHashPackage());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.pkg = activePkg;
  }, [activePkg]);

  const selectPackage = useCallback((pkg: PackageId) => {
    setActivePkg(pkg);
    const url = pkg === DEFAULT_PACKAGE ? window.location.pathname : `#${pkg}`;
    window.history.replaceState(null, '', url);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <div className="relative min-h-screen w-full overflow-x-clip">
      <MatrixRain opacity={0.045} color="#00ff41" fontSize={14} speed={45} />

      <div
        className="pointer-events-none fixed inset-0 z-[1] bg-[repeating-linear-gradient(0deg,rgba(0,0,0,0.025)_0px,rgba(0,0,0,0.025)_1px,transparent_1px,transparent_2px)] bg-[size:100%_2px]"
        aria-hidden
      />

      <SiteNav activePkg={activePkg} onChange={selectPackage} />
      <PackagePanel active={activePkg} onSelectPackage={selectPackage} />
      <SiteFooter />
    </div>
  );
}
