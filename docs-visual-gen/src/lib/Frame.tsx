import { type CSSProperties, forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import './theme.css';
import './frame.css';

/**
 * `light` / `dark` pick a palette; `auto` follows the nearest `[data-mode="dark" | "light"]`
 * ancestor (how the website switches modes) and falls back to light.
 */
export type FrameTheme = 'light' | 'dark' | 'auto';

export interface FrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Canvas size in px. Every lib component is positioned in these canvas coordinates. */
  width: number;
  height: number;
  /** Defaults to `light`. */
  theme?: FrameTheme;
  children?: ReactNode;
}

/**
 * The canvas every visual is drawn on: a dotted canvas holding the theme tokens.
 * Captured by the renderer via `[data-frame]`. Extra props (aria-label, role, className,
 * style ...) land on the frame element; the ref too, e.g. as an anime.js scope root.
 */
export const Frame = forwardRef<HTMLDivElement, FrameProps>(function Frame(
  { width, height, theme = 'light', className, style, children, ...rest },
  ref,
) {
  return (
    <div
      {...rest}
      ref={ref}
      className={className ? `dv-frame ${className}` : 'dv-frame'}
      data-frame
      data-theme={theme}
      style={{ ...style, width, height } as CSSProperties}
    >
      {children}
    </div>
  );
});
