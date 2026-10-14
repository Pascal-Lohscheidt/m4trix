import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DocsShell } from '@/components/docs/DocsShell';
import { MODE_INIT_SCRIPT } from '@/components/docs/ThemeToggle';
import { DOCS_TABS, docsHref, type NavTab } from '@/lib/docs/navigation';
import { getAllPages } from '@/lib/docs/source';
import '@/styles/docs.css';

export const metadata: Metadata = {
  title: {
    template: '%s | m4trix docs',
    default: 'm4trix docs',
  },
  description:
    'Docs for m4trix: event-driven, type-safe agent networks, evals and tracing for TypeScript.',
};

async function buildNav(): Promise<NavTab[]> {
  const pages = new Map((await getAllPages()).map((page) => [page.slug, page]));
  return DOCS_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: tab.href,
    groups: tab.groups.map((group) => ({
      group: group.group,
      pages: group.pages.map((slug) => ({
        slug,
        href: docsHref(slug),
        label: pages.get(slug)?.sidebarTitle ?? slug,
      })),
    })),
  }));
}

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const nav = await buildNav();
  return (
    <>
      {/* Applies a stored light/dark choice before first paint. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script */}
      <script dangerouslySetInnerHTML={{ __html: MODE_INIT_SCRIPT }} />
      <DocsShell nav={nav}>{children}</DocsShell>
    </>
  );
}
