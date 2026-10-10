import type { CSSProperties, ReactNode } from 'react';

/** Top-left anchored box in canvas pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Point in canvas pixels. */
export interface Point {
  x: number;
  y: number;
}

export const boxStyle = ({ x, y, w, h }: Box): CSSProperties => ({
  position: 'absolute',
  left: x,
  top: y,
  width: w,
  height: h,
});

/** Positions children so that `at` is their visual center. */
export function Centered({ at, children }: { at: Point; children: ReactNode }) {
  return (
    <div
      style={{ position: 'absolute', left: at.x, top: at.y, transform: 'translate(-50%, -50%)' }}
    >
      {children}
    </div>
  );
}
