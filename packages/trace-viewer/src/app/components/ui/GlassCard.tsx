import type { ReactNode, Ref } from 'react';
import { cx } from '../../lib/viewer';

/** Rounded glass surface with a fixed title row and its own scroll area. */
export function GlassCard({
  title,
  actions,
  className,
  bodyRef,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      className={cx('glass flex min-h-0 min-w-0 flex-col overflow-clip rounded-[28px]', className)}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 pt-5 pb-3">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-50">{title}</h2>
        {actions}
      </div>
      <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-auto px-4 pb-4">
        {children}
      </div>
    </section>
  );
}
