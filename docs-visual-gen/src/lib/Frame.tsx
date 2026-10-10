import type { ReactNode, Ref } from 'react';
import './theme.css';
import './frame.css';

/** The canvas every visual is drawn on: cool gray with a dot grid. Captured by the renderer. */
export function Frame({
  width,
  height,
  children,
  ref,
}: {
  width: number;
  height: number;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div className="frame" data-frame ref={ref} style={{ width, height }}>
      {children}
    </div>
  );
}
