'use client';

import { MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

export const MODE_STORAGE_KEY = 'm4trix-mode';

/** Where the docs park the rest of the site's mode while they apply their own. */
const SITE_MODE_ATTR = 'data-site-mode';

/**
 * The docs keep their own light/dark choice; the rest of the site has its own mode on
 * `<html data-mode>`. Entering the docs remembers the site's mode and applies the stored docs
 * mode; leaving restores the site's mode, so a docs choice never leaks onto the landing page.
 *
 * Runs before paint on full page loads (inlined in the docs layout), so a stored mode doesn't
 * flash. `applyDocsMode` below does the same for client-side navigation, where inline scripts
 * don't run; keep the two in sync.
 */
export const MODE_INIT_SCRIPT = `try{var h=document.documentElement;if(!h.hasAttribute('${SITE_MODE_ATTR}'))h.setAttribute('${SITE_MODE_ATTR}',h.getAttribute('data-mode')||'dark');var m=localStorage.getItem('${MODE_STORAGE_KEY}');if(m==='light'||m==='dark')h.setAttribute('data-mode',m)}catch(e){}`;

export function applyDocsMode() {
  const html = document.documentElement;
  if (!html.hasAttribute(SITE_MODE_ATTR)) {
    html.setAttribute(SITE_MODE_ATTR, html.getAttribute('data-mode') ?? 'dark');
  }
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') html.setAttribute('data-mode', stored);
  } catch {}
}

/** Puts the site's own mode back when leaving the docs. */
export function restoreSiteMode() {
  const html = document.documentElement;
  const site = html.getAttribute(SITE_MODE_ATTR);
  if (site) html.setAttribute('data-mode', site);
  html.removeAttribute(SITE_MODE_ATTR);
}

export function ThemeToggle() {
  const [mode, setMode] = useState<'dark' | 'light' | null>(null);

  useEffect(() => {
    setMode(document.documentElement.getAttribute('data-mode') === 'light' ? 'light' : 'dark');
  }, []);

  if (!mode) return <span className="docs-icon-btn docs-icon-btn-lg" aria-hidden />;
  const next = mode === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      className="docs-icon-btn docs-icon-btn-lg"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        document.documentElement.setAttribute('data-mode', next);
        try {
          localStorage.setItem(MODE_STORAGE_KEY, next);
        } catch {}
        setMode(next);
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
