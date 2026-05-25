import type { Icon } from '@phosphor-icons/react';

export function BentoIcon({ icon: IconComponent }: { icon: Icon }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-(--accent-border) bg-(--accent-dim) text-(--accent) transition-[color,border-color,background] duration-300">
      <IconComponent aria-hidden className="h-4 w-4" weight="bold" />
    </div>
  );
}
