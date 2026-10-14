'use client';

import { Children, type ReactNode, useEffect, useId, useState } from 'react';
import { CopyButton } from './CopyButton';

const STORAGE_KEY = 'm4trix-docs-code-tab';

/**
 * Tabbed code blocks (e.g. pnpm / npm / yarn). The chosen tab label is remembered and shared
 * by every group on the site that has a tab with the same label.
 */
export function CodeTabs({
  labels,
  codes,
  children,
}: {
  labels: string[];
  codes: string[];
  children: ReactNode;
}) {
  const panels = Children.toArray(children);
  const [active, setActive] = useState(0);
  const id = useId();

  useEffect(() => {
    const sync = () => {
      const stored = localStorage.getItem(STORAGE_KEY);
      const index = stored ? labels.indexOf(stored) : -1;
      if (index !== -1) setActive(index);
    };
    sync();
    window.addEventListener('m4trix-code-tab', sync);
    return () => window.removeEventListener('m4trix-code-tab', sync);
  }, [labels]);

  const select = (index: number) => {
    setActive(index);
    localStorage.setItem(STORAGE_KEY, labels[index]);
    window.dispatchEvent(new Event('m4trix-code-tab'));
  };

  return (
    <figure className="docs-code not-prose">
      <div className="docs-code-head">
        <div role="tablist" aria-label="Code variants" className="flex min-w-0 gap-1">
          {labels.map((label, index) => (
            <button
              key={label}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={index === active}
              aria-controls={`${id}-panel-${index}`}
              className={`docs-code-tab ${index === active ? 'docs-code-tab-active' : ''}`}
              onClick={() => select(index)}
            >
              {label}
            </button>
          ))}
        </div>
        <CopyButton value={codes[active] ?? ''} />
      </div>
      {panels.map((panel, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: panels are positional, like the labels
          key={index}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          hidden={index !== active}
        >
          {panel}
        </div>
      ))}
    </figure>
  );
}
