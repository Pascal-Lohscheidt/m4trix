import Image from 'next/image';
import Link from 'next/link';

const LOGO_SRC = '/m4trix_logo_tr.png';

type LogoSize = 'sm' | 'md' | 'lg';

const LOGO_SIZES: Record<LogoSize, { px: number; className: string }> = {
  sm: { px: 28, className: 'h-7 w-7' },
  md: { px: 32, className: 'h-8 w-8' },
  lg: { px: 40, className: 'h-10 w-10' },
};

export function Logo({
  size = 'md',
  priority = false,
  className = '',
}: {
  size?: LogoSize;
  priority?: boolean;
  className?: string;
}) {
  const { px, className: sizeClass } = LOGO_SIZES[size];

  return (
    <Image
      src={LOGO_SRC}
      alt=""
      width={px}
      height={px}
      priority={priority}
      className={`shrink-0 ${sizeClass} ${className}`.trim()}
      aria-hidden
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

export function Brand({ priority = true }: { priority?: boolean }) {
  return (
    <Link href="/" className="inline-flex items-center gap-2.5 transition-opacity hover:opacity-90">
      <Logo size="md" priority={priority} />
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
