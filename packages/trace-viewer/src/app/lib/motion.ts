import { animate, createScope, type Scope, spring, stagger } from 'animejs';
import { type RefObject, useLayoutEffect, useRef } from 'react';

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

export const glassSpring = spring({ stiffness: 220, damping: 26 });
export const glassEase = 'cubicBezier(0.16, 1, 0.3, 1)';

/**
 * Fades + lifts every `[data-reveal]` descendant of `root` whenever `replayKey` changes.
 * Used for state transitions (new trace / new run selected), not for decoration.
 */
export function useReveal(
  root: RefObject<HTMLElement | null>,
  replayKey: unknown,
  options: { distance?: number; staggerMs?: number; selector?: string; enabled?: boolean } = {},
): void {
  const { distance = 10, staggerMs = 40, selector = '[data-reveal]', enabled = true } = options;
  const scope = useRef<Scope | null>(null);

  // Layout effect so targets are hidden before first paint (no flash of final state).
  // biome-ignore lint/correctness/useExhaustiveDependencies: replayKey is the replay trigger, not read inside
  useLayoutEffect(() => {
    if (!enabled || !root.current) return;
    scope.current = createScope({ root, mediaQueries: { reduce: REDUCE_QUERY } }).add((self) => {
      if (self?.matches.reduce) return;
      const targets = root.current?.querySelectorAll(selector);
      if (!targets?.length) return;
      animate(targets, {
        opacity: [0, 1],
        y: [distance, 0],
        duration: 520,
        delay: stagger(staggerMs),
        ease: glassEase,
      });
    });
    return () => scope.current?.revert();
  }, [root, replayKey, enabled, selector, distance, staggerMs]);
}

/**
 * Glides an absolutely positioned indicator under the `[data-active="true"]` child of
 * `container`. Gives segmented controls a physical "liquid" selection.
 */
export function useSlidingIndicator(
  container: RefObject<HTMLElement | null>,
  indicator: RefObject<HTMLElement | null>,
  activeKey: string | null | undefined,
): void {
  const placed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKey changes which child carries data-active
  useLayoutEffect(() => {
    const host = container.current;
    const pill = indicator.current;
    if (!host || !pill) return;

    const place = (instant: boolean) => {
      const active = host.querySelector<HTMLElement>('[data-active="true"]');
      if (!active) {
        pill.style.opacity = '0';
        return;
      }
      const target = {
        x: active.offsetLeft,
        y: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight,
        opacity: 1,
      };
      const reduce = window.matchMedia(REDUCE_QUERY).matches;
      if (instant || reduce) {
        animate(pill, { ...target, duration: 0 });
      } else {
        animate(pill, { ...target, ease: glassSpring });
      }
    };

    place(!placed.current);
    placed.current = true;

    const ro = new ResizeObserver(() => place(true));
    ro.observe(host);
    return () => ro.disconnect();
  }, [container, indicator, activeKey]);
}
