export type PackageId = 'agents' | 'evals' | 'tracing';

export const PKG_NAV_META: Record<
  PackageId,
  { badge: string; docsLabel: string; docsHref: string }
> = {
  agents: {
    badge: 'Pre-Alpha',
    docsLabel: 'read docs',
    docsHref: 'https://docs.m4trix.dev',
  },
  evals: {
    badge: 'Beta',
    docsLabel: 'evals docs',
    docsHref: 'https://docs.m4trix.dev/evals',
  },
  tracing: {
    badge: 'Stable',
    docsLabel: 'tracing docs',
    docsHref: 'https://docs.m4trix.dev/tracing',
  },
};

export const TABS: { id: PackageId; label: string; badge?: string }[] = [
  { id: 'agents', label: 'Agent Orchestrator', badge: 'Pre-Alpha' },
  { id: 'evals', label: 'Evals' },
  { id: 'tracing', label: 'Tracing' },
];
