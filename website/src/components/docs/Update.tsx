import type { ReactNode } from 'react';
import { updateId } from '@/lib/docs/anchors';

/** Changelog entry, as emitted by `scripts/generate-changelogs.ts`. */
export function Update({
  label,
  description,
  tags,
  children,
}: {
  label: string;
  description?: string;
  tags?: string[];
  rss?: unknown;
  children: ReactNode;
}) {
  const id = updateId(label);
  return (
    <section className="docs-update" aria-labelledby={id}>
      <div className="docs-update-meta not-prose">
        <a id={id} href={`#${id}`} className="docs-update-label">
          {label}
        </a>
        {tags?.length ? (
          <span className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="docs-update-tag">
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="docs-update-body">
        {description ? <p className="docs-update-desc">{description}</p> : null}
        {children}
      </div>
    </section>
  );
}
