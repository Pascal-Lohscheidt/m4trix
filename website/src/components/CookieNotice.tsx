'use client';

import { CookieIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

// The site sets no cookies. Dismissal is remembered in localStorage, which is the only thing
// stored, and only so the notice does not come back on every visit.
const STORAGE_KEY = 'm4trix-cookie-notice';

export default function CookieNotice() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORAGE_KEY) !== 'dismissed');
    } catch {
      setOpen(true);
    }
  }, []);

  if (!open) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'dismissed');
    } catch {
      // Storage blocked: hide for this visit only.
    }
    setOpen(false);
  };

  return (
    <section aria-label="Cookie notice" className="cookie-notice glass">
      <CookieIcon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-(--accent)" />
      <p className="text-[13.5px] leading-relaxed text-text-2">
        We only use functional cookies the site needs to work. No tracking, no analytics.
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="btn-primary shrink-0 px-4 py-2 text-[13px]"
      >
        OK
      </button>
    </section>
  );
}
