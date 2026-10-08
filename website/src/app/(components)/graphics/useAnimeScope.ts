'use client';

import { createScope, type Scope } from 'animejs';
import { type RefObject, useEffect } from 'react';

/**
 * Runs an anime.js setup inside a scope bound to `root`.
 * Under prefers-reduced-motion the setup is skipped, so graphics must render
 * their final state by default and only hide elements from inside `setup`.
 */
export function useAnimeScope(
  root: RefObject<HTMLElement | null>,
  setup: (el: HTMLElement) => void,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: setup is static per graphic
  useEffect(() => {
    const scope: Scope = createScope({
      root: root as RefObject<HTMLElement>,
      mediaQueries: { reduce: '(prefers-reduced-motion: reduce)' },
    }).add((self) => {
      if (!root.current || self.matches.reduce) return;
      setup(root.current);
    });
    return () => scope.revert();
  }, []);
}
