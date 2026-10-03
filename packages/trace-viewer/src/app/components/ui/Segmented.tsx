import { type ReactNode, useRef } from 'react';
import { useSlidingIndicator } from '../../lib/motion';
import { cx } from '../../lib/viewer';

export type SegmentedItem<K extends string> = {
  key: K;
  label: ReactNode;
  ariaLabel?: string;
  title?: string;
};

type SegmentedProps<K extends string> = {
  items: SegmentedItem<K>[];
  value: K | null;
  onChange: (key: K) => void;
  legend: string;
  size?: 'sm' | 'md';
  className?: string;
};

/** Glass segmented control with a spring-driven selection pill. */
export function Segmented<K extends string>({
  items,
  value,
  onChange,
  legend,
  size = 'sm',
  className,
}: SegmentedProps<K>): ReactNode {
  const host = useRef<HTMLFieldSetElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  useSlidingIndicator(host, pill, value);

  return (
    <fieldset
      ref={host}
      className={cx('glass-well relative m-0 flex rounded-full border-0 p-1', className)}
    >
      <legend className="sr-only">{legend}</legend>
      <span
        ref={pill}
        aria-hidden="true"
        className="glass-chip pointer-events-none absolute top-0 left-0 rounded-full bg-violet-400/15 opacity-0"
      />
      {items.map((item) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            data-active={selected}
            aria-pressed={selected}
            aria-label={item.ariaLabel}
            title={item.title}
            onClick={() => onChange(item.key)}
            className={cx(
              'relative z-10 inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap transition-colors duration-200',
              size === 'sm' ? 'px-3 py-1 text-xs' : 'px-2.5 py-1.5 text-sm',
              selected ? 'text-violet-100' : 'text-zinc-400 hover:text-zinc-100',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </fieldset>
  );
}
