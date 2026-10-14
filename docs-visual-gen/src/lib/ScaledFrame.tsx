'use client';

import { type CSSProperties, forwardRef, useEffect, useRef } from 'react';
import { Frame, type FrameProps } from './Frame';

export interface ScaledFrameProps extends FrameProps {
  /** Class on the outer, responsive box (round its corners, add a border, ...). */
  wrapperClassName?: string;
  wrapperStyle?: CSSProperties;
  /** Allow scaling above the canvas size when the container is wider. Default false. */
  upscale?: boolean;
}

const CSS_SCALE = 'scale(tan(atan2(100cqw, 100px)))';

/**
 * Renders a Frame at its canvas size and scales it to the container's width, keeping the
 * aspect ratio. The box reserves its height with `aspect-ratio` and the scale is computed
 * in CSS from container units, so the server-rendered HTML is already laid out and scaled:
 * no layout jump, no flash. Browsers without CSS trig / container units get the scale from
 * a ResizeObserver after hydration.
 *
 * The ref points at the inner Frame (canvas coordinates), e.g. for an anime.js scope.
 */
export const ScaledFrame = forwardRef<HTMLDivElement, ScaledFrameProps>(function ScaledFrame(
  { wrapperClassName, wrapperStyle, upscale = false, ...frameProps },
  ref,
) {
  const { width, height } = frameProps;
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    if (typeof CSS !== 'undefined' && CSS.supports('transform', CSS_SCALE)) return;
    const observer = new ResizeObserver(([entry]) => {
      el.style.setProperty('--dv-scale', String(entry.contentRect.width / width));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      el.style.removeProperty('--dv-scale');
    };
  }, [width]);

  return (
    <div
      ref={box}
      className={wrapperClassName ? `dv-scaled ${wrapperClassName}` : 'dv-scaled'}
      style={
        {
          aspectRatio: `${width} / ${height}`,
          maxWidth: upscale ? undefined : width,
          '--dv-canvas-width': `${width}px`,
          ...wrapperStyle,
        } as CSSProperties
      }
    >
      <Frame ref={ref} {...frameProps} />
    </div>
  );
});
