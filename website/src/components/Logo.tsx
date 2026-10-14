import { PinwheelMark } from 'docs-visual-gen/brand';
import Link from 'next/link';

type LogoSize = 'sm' | 'md' | 'lg';

const LOGO_SIZES: Record<LogoSize, { px: number; weight: number }> = {
  sm: { px: 28, weight: 8.5 },
  md: { px: 32, weight: 8 },
  lg: { px: 40, weight: 7.5 },
};

/**
 * The m4trix mark (a pinwheel cube, drawn in docs-visual-gen/src/lib/brand). It strokes in
 * `currentColor`, so it follows the text color in light and dark mode.
 */
export function Logo({ size = 'md', className = '' }: { size?: LogoSize; className?: string }) {
  const { px, weight } = LOGO_SIZES[size];
  return (
    <PinwheelMark
      size={px}
      weight={weight}
      aria-hidden
      className={`shrink-0 text-text-1 ${className}`.trim()}
    />
  );
}

export function Wordmark(props: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      className="inline-flex items-center font-mono text-[15px] font-bold tracking-wide text-text-1"
      {...props}
    >
      <em className="not-italic text-(--accent) transition-[color] duration-300">m</em>
      4trix
    </span>
  );
}

export function Brand() {
  return (
    <Link href="/" className="inline-flex items-center gap-2.5 transition-opacity hover:opacity-90">
      <Logo size="md" />
      <Wordmark />
    </Link>
  );
}

export function ImageLogoWithText(
  props: React.ComponentPropsWithoutRef<'span'> & { alt?: string },
) {
  const { alt: _alt, ...rest } = props;
  return <Wordmark {...rest} />;
}
