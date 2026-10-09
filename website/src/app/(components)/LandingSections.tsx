'use client';

import { ArrowRightIcon, PlusIcon } from '@phosphor-icons/react';
import { type SimpleIcon, siGithub } from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import type { PackageId } from '@/lib/packages';

export const GITHUB_HREF = 'https://github.com/Pascal-Lohscheidt/m4trix';

export function Section({
  id,
  className = '',
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={`relative z-[2] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 ${className}`.trim()}
    >
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

/* ─── Works with ──────────────────────────────────────────────────────── */

export function WorksWith({ label, icons }: { label: string; icons: SimpleIcon[] }) {
  return (
    <div className="relative z-[2] px-4 pt-6 pb-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <p className="text-center text-sm text-text-3">{label}</p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
          {icons.map((icon) => (
            <li
              key={icon.slug}
              className="flex items-center gap-2.5 text-text-3 transition-colors hover:text-text-1"
            >
              <BrandIcon icon={icon} />
              <span className="text-sm font-medium">{icon.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ─── FAQ ─────────────────────────────────────────────────────────────── */

export type FaqItem = { q: string; a: string };

export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <Section>
      <div className="grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
        <h2 className="lp-h2">Questions</h2>
        <div className="border-t border-(--border)">
          {items.map((item) => (
            <details key={item.q} className="faq-item group">
              <summary>
                {item.q}
                <PlusIcon aria-hidden className="faq-icon h-5 w-5" />
              </summary>
              <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-text-2">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ─── Rest of the toolkit ─────────────────────────────────────────────── */

export type Sibling = { id: PackageId; name: string; title: string; body: string };

export function Toolkit({
  siblings,
  onSelectPackage,
}: {
  siblings: Sibling[];
  onSelectPackage: (pkg: PackageId) => void;
}) {
  return (
    <Section>
      <h2 className="lp-h2">Part of the m4trix toolkit</h2>
      <p className="lp-lead">
        Each package works on its own. Together they share one TypeScript model.
      </p>
      <div className="mt-10 grid gap-4 md:grid-cols-2">
        {siblings.map((pkg) => (
          <button
            key={pkg.id}
            type="button"
            onClick={() => onSelectPackage(pkg.id)}
            className="group bento-cell cursor-pointer text-left transition-[border-color] hover:border-(--accent-border)"
          >
            <span className="font-mono text-[13px] text-text-3">{pkg.name}</span>
            <span className="mt-3 flex items-center gap-2 font-display text-xl font-semibold text-text-1">
              {pkg.title}
              <ArrowRightIcon
                aria-hidden
                className="h-4 w-4 text-text-3 transition-transform group-hover:translate-x-0.5"
                weight="bold"
              />
            </span>
            <span className="bento-body">{pkg.body}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/* ─── Closing CTA ─────────────────────────────────────────────────────── */

export function ClosingCta({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <section className="relative z-[2] px-4 pt-6 pb-20 sm:px-6 lg:px-8">
      <div
        className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-(--accent-border) px-6 py-16 text-center sm:px-12"
        style={{
          background:
            'radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 65%), color-mix(in srgb, var(--bg-raised) 60%, transparent)',
        }}
      >
        <h2 className="lp-h2 mx-auto max-w-xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-[46ch] text-base leading-relaxed text-text-2">{body}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href={href} className="btn-primary group">
            Get started
            <ArrowRightIcon
              aria-hidden
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              weight="bold"
            />
          </a>
          <a href={GITHUB_HREF} className="btn-secondary">
            <BrandIcon icon={siGithub} className="h-4 w-4" />
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
