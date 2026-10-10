import { createScope, createTimeline, type Timeline } from 'animejs';
import { useEffect, useRef } from 'react';

export interface SceneController {
  seek: (ms: number) => void;
}

declare global {
  interface Window {
    __scene?: { ready: boolean; seek: (ms: number) => void };
  }
}

export const isCapture = () => new URLSearchParams(window.location.search).has('capture');

let controller: SceneController | null = null;

/** Called by the app shell once fonts are loaded; the render script waits for this. */
export function markSceneReady() {
  window.__scene = {
    ready: true,
    seek: (ms) => {
      controller?.seek(ms);
    },
  };
}

/**
 * Builds a scene's anime.js timeline inside a scope bound to the frame root.
 *
 * - capture mode (`?capture`): paused; the render script drives `seek(ms)` frame by frame,
 *   which keeps GIF output deterministic.
 * - preview: loops. Under prefers-reduced-motion it holds still on `posterAtMs`.
 *
 * Every scene must end in the same state it starts in so the GIF loops seamlessly.
 */
export function useSceneTimeline(
  build: (tl: Timeline) => void,
  { durationMs, posterAtMs }: { durationMs: number; posterAtMs: number },
) {
  const root = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: built once per mount
  useEffect(() => {
    const scope = createScope({
      root,
      mediaQueries: { reduce: '(prefers-reduced-motion: reduce)' },
    }).add((self) => {
      const tl = createTimeline({ autoplay: false, loop: true });
      build(tl);
      // Pad to the exact loop length so preview and capture agree.
      tl.add({ duration: 1 }, durationMs - 1);

      if (isCapture()) {
        // Block body: returning the Timeline would make Playwright serialize its object graph.
        controller = {
          seek: (ms) => {
            tl.seek(ms);
          },
        };
      } else if (self?.matches.reduce) {
        tl.seek(posterAtMs);
      } else {
        tl.play();
      }
    });
    return () => {
      controller = null;
      scope.revert();
    };
  }, []);

  return root;
}
