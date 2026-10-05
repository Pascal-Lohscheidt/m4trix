import type { SimpleIcon } from 'simple-icons';

export function BrandIcon({
  icon,
  className = 'h-5 w-5',
}: {
  icon: SimpleIcon;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d={icon.path} />
    </svg>
  );
}
