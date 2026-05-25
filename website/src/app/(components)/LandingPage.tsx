'use client';

import { useEffect, useState } from 'react';
import { Wordmark } from '@/components/Logo';
import { PKG_NAV_META, type PackageId } from '@/lib/packages';
import MatrixRain from './MatrixRain';
import PackageTabs from './PackageTabs';

function ModeToggle() {
  const [mode, setMode] = useState<'dark' | 'light'>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const current =
      document.documentElement.getAttribute('data-mode') === 'light' ? 'light' : 'dark';
    setMode(current);
    setMounted(true);
  }, []);

  const switchMode = (next: 'dark' | 'light') => {
    setMode(next);
    document.documentElement.setAttribute('data-mode', next);
  };

  if (!mounted) {
    return <div className="mode-toggle h-[30px] w-[88px]" aria-hidden />;
  }

  return (
    <div className="mode-toggle">
      <button
        type="button"
        className={`mode-btn ${mode === 'dark' ? 'mode-btn-active' : ''}`}
        onClick={() => switchMode('dark')}
      >
        Dark
      </button>
      <button
        type="button"
        className={`mode-btn ${mode === 'light' ? 'mode-btn-active' : ''}`}
        onClick={() => switchMode('light')}
      >
        Light
      </button>
    </div>
  );
}

function SiteNav({ activePkg }: { activePkg: PackageId }) {
  const meta = PKG_NAV_META[activePkg];

  return (
    <nav
      className="sticky top-0 z-50 border-b backdrop-blur-xl transition-[border-color,background] duration-300"
      style={{
        borderColor: 'var(--border)',
        background: 'color-mix(in srgb, var(--bg) 94%, transparent)',
      }}
    >
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6 lg:px-8">
        <div className="flex items-center gap-2.5">
          <Wordmark />
          <span className="badge-accent">
            <span className="badge-accent-dot" />
            {meta.badge}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ModeToggle />
          <a href="https://github.com/Pascal-Lohscheidt/m4trix" className="btn-nav-ghost">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
            GitHub
          </a>
          <a href={meta.docsHref} className="btn-nav-docs group">
            <span className="opacity-60">$</span>
            <span>{meta.docsLabel}</span>
            <span className="opacity-0 transition-opacity group-hover:opacity-100">→</span>
          </a>
        </div>
      </div>
    </nav>
  );
}

function SiteFooter() {
  return (
    <footer
      className="relative z-10 border-t transition-[border-color,background] duration-300"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--bg)',
      }}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-2 font-mono text-[11px] lg:px-8">
        <div className="flex items-center gap-3.5" style={{ color: 'var(--text-4)' }}>
          <span className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full transition-[background] duration-300"
              style={{ background: 'var(--accent)' }}
            />
            main
          </span>
          <span>MIT</span>
          <span>Pascal Lohscheidt</span>
        </div>
        <div className="flex items-center gap-3.5" style={{ color: 'var(--text-4)' }}>
          <a
            href="https://github.com/Pascal-Lohscheidt/m4trix"
            aria-label="GitHub"
            className="transition-colors hover:text-(--accent)"
          >
            <svg
              className="inline h-3.5 w-3.5"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
          </a>
          <span>© {new Date().getFullYear()}</span>
          <span>TypeScript</span>
          <span>UTF-8</span>
        </div>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  const [activePkg, setActivePkg] = useState<PackageId>('agents');

  useEffect(() => {
    document.documentElement.dataset.pkg = activePkg;
  }, [activePkg]);

  const handleTabChange = (pkg: PackageId) => {
    setActivePkg(pkg);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="relative min-h-screen w-full">
      <MatrixRain opacity={0.055} color="#00ff41" fontSize={14} speed={45} />

      <div
        className="pointer-events-none fixed inset-0 z-[1] bg-[repeating-linear-gradient(0deg,rgba(0,0,0,0.025)_0px,rgba(0,0,0,0.025)_1px,transparent_1px,transparent_2px)] bg-[size:100%_2px]"
        aria-hidden
      />

      <SiteNav activePkg={activePkg} />
      <PackageTabs active={activePkg} onChange={handleTabChange} />
      <SiteFooter />
    </div>
  );
}
