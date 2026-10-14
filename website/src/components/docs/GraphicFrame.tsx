'use client';

import { ArrowsInSimpleIcon, ArrowsOutSimpleIcon } from '@phosphor-icons/react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

type Expanded = 'native' | 'overlay' | null;

/**
 * Thin glass frame around a docs graphic (diagram, run player, rendered visual) with an
 * "expand" control that appears on hover or keyboard focus (always on touch screens).
 *
 * Expanding puts this same element into full screen (Fullscreen API), so live graphics such as
 * the run player keep their state. Where elements can't go full screen (iPhone Safari), the
 * frame becomes a fixed overlay that covers the viewport instead. Esc leaves either mode.
 */
export function GraphicFrame({
  label,
  aspect,
  children,
}: {
  /** What the graphic is, for the button's accessible name, e.g. "network diagram". */
  label: string;
  /** Width / height of the graphic, so it can fit the screen's height when expanded. */
  aspect?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState<Expanded>(null);

  useEffect(() => {
    const onChange = () => {
      setExpanded((current) =>
        document.fullscreenElement === ref.current
          ? 'native'
          : current === 'native'
            ? null
            : current,
      );
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Browsers exit real full screen on Esc themselves; this covers any Esc that reaches the page.
  useEffect(() => {
    if (expanded !== 'native') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement === ref.current) {
        document.exitFullscreen().catch(() => {});
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  // Overlay mode: lock page scroll, close on Esc, return focus to the button.
  useEffect(() => {
    if (expanded !== 'overlay') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
      buttonRef.current?.focus({ preventScroll: true });
    };
  }, [expanded]);

  const toggle = useCallback(async () => {
    const el = ref.current;
    if (!el) return;
    if (expanded === 'native') {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (expanded === 'overlay') {
      setExpanded(null);
      return;
    }
    if (document.fullscreenEnabled && el.requestFullscreen) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
        return;
      } catch {
        // Fall through to the overlay (e.g. blocked by a permissions policy).
      }
    }
    setExpanded('overlay');
  }, [expanded]);

  const isOpen = expanded !== null;

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is only set together with role="dialog"
    <div
      ref={ref}
      className="docs-graphic not-prose"
      data-expanded={expanded ?? undefined}
      role={expanded === 'overlay' ? 'dialog' : undefined}
      aria-modal={expanded === 'overlay' ? true : undefined}
      aria-label={expanded === 'overlay' ? `${label}, full screen` : undefined}
      style={aspect ? ({ '--graphic-aspect': aspect } as CSSProperties) : undefined}
    >
      <div className="docs-graphic-inner">{children}</div>
      <button
        ref={buttonRef}
        type="button"
        className="docs-graphic-expand"
        aria-label={isOpen ? 'Exit full screen' : `View ${label} full screen`}
        title={isOpen ? 'Exit full screen (Esc)' : 'View full screen'}
        onClick={toggle}
      >
        {isOpen ? (
          <ArrowsInSimpleIcon aria-hidden className="h-4 w-4" />
        ) : (
          <ArrowsOutSimpleIcon aria-hidden className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
