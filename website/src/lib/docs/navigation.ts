import type { PackageId } from '@/lib/packages';

/**
 * Docs information architecture. Page slugs are paths under `content/docs` without the
 * `.mdx` extension; `index` is the docs home. Labels come from each page's frontmatter
 * (`sidebarTitle`, falling back to `title`).
 */

export interface DocsGroup {
  group: string;
  pages: string[];
}

export interface DocsTab {
  id: PackageId;
  label: string;
  /** First page of the tab; also where the header tab links to. */
  href: string;
  groups: DocsGroup[];
}

export const DOCS_TABS: DocsTab[] = [
  {
    id: 'agents',
    label: 'Agents',
    href: '/docs',
    groups: [
      {
        group: 'Getting Started',
        pages: [
          'index',
          'getting-started/install',
          'getting-started/hello-world',
          'getting-started/run-expected-output',
          'getting-started/whats-happening',
          'getting-started/how-to',
          'getting-started/next-steps',
        ],
      },
      {
        group: 'Concepts',
        pages: [
          'concepts/events',
          'concepts/channels',
          'concepts/agents',
          'concepts/networks',
          'concepts/context',
          'concepts/streaming-sinks-adapters',
          'concepts/package-structure',
        ],
      },
      {
        group: 'Guides',
        pages: [
          'guides/patterns',
          'guides/streaming',
          'guides/auth-multitenant',
          'guides/error-handling-observability',
          'guides/testing',
          'guides/deployment',
          'guides/nextjs',
          'guides/express',
        ],
      },
      {
        group: 'API Reference',
        pages: [
          'api-reference/agent-factory',
          'api-reference/agent-network',
          'api-reference/agent-network-event',
          'api-reference/channel-api',
          'api-reference/io-adapters',
          'api-reference/types-advanced',
        ],
      },
      {
        group: 'Examples',
        pages: [
          'examples/minimal-starter',
          'examples/multi-agent-workflow',
          'examples/rag-tools',
          'examples/eval-harness',
          'examples/common-recipes',
        ],
      },
      {
        group: 'Project',
        pages: [
          'project/versioning-stability',
          'project/changelog',
          'project/changelog-migrations',
          'project/faq-troubleshooting',
          'project/security',
          'project/contributing',
        ],
      },
    ],
  },
  {
    id: 'evals',
    label: 'Evals',
    href: '/docs/evals/overview',
    groups: [
      { group: 'Getting Started', pages: ['evals/overview', 'evals/quick-start'] },
      { group: 'Guides', pages: ['evals/concepts', 'evals/cli-and-config'] },
      { group: 'API Reference', pages: ['evals/api-reference'] },
      { group: 'Project', pages: ['evals/changelog'] },
    ],
  },
  {
    id: 'tracing',
    label: 'Tracing',
    href: '/docs/tracing/overview',
    groups: [
      { group: 'Getting Started', pages: ['tracing/overview', 'tracing/quick-start'] },
      { group: 'Guides', pages: ['tracing/concepts', 'tracing/cli-and-viewer'] },
      { group: 'API Reference', pages: ['tracing/api-reference'] },
      { group: 'Project', pages: ['tracing/changelog'] },
    ],
  },
];

/** Every page in navigation order. */
export const DOCS_SLUGS: string[] = DOCS_TABS.flatMap((tab) =>
  tab.groups.flatMap((group) => group.pages),
);

export function docsHref(slug: string): string {
  return slug === 'index' ? '/docs' : `/docs/${slug}`;
}

/** Inverse of `docsHref`: `/docs/concepts/events` → `concepts/events`. */
export function slugFromPathname(pathname: string): string {
  const rest = pathname.replace(/^\/docs\/?/, '').replace(/\/$/, '');
  return rest === '' ? 'index' : rest;
}

export function findTab(slug: string): DocsTab {
  return DOCS_TABS.find((tab) => tab.groups.some((g) => g.pages.includes(slug))) ?? DOCS_TABS[0];
}

export function findGroup(slug: string): DocsGroup | undefined {
  for (const tab of DOCS_TABS) {
    const group = tab.groups.find((g) => g.pages.includes(slug));
    if (group) return group;
  }
  return undefined;
}

/** Previous / next page within the same tab. */
export function siblings(slug: string): { prev?: string; next?: string } {
  const pages = findTab(slug).groups.flatMap((g) => g.pages);
  const index = pages.indexOf(slug);
  if (index === -1) return {};
  return { prev: pages[index - 1], next: pages[index + 1] };
}

/** Navigation with resolved labels, as passed from the server layout to client components. */
export interface NavPage {
  slug: string;
  href: string;
  label: string;
}

export interface NavTab {
  id: PackageId;
  label: string;
  href: string;
  groups: { group: string; pages: NavPage[] }[];
}
