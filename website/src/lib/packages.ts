export type PackageId = 'tracing' | 'evals' | 'agents';

export const DEFAULT_PACKAGE: PackageId = 'tracing';

export const PKG_NAV_META: Record<PackageId, { docsLabel: string; docsHref: string }> = {
  tracing: {
    docsLabel: 'Docs',
    docsHref: 'https://docs.m4trix.dev/tracing',
  },
  evals: {
    docsLabel: 'Docs',
    docsHref: 'https://docs.m4trix.dev/evals',
  },
  agents: {
    docsLabel: 'Docs',
    docsHref: 'https://docs.m4trix.dev',
  },
};

export const TABS: { id: PackageId; label: string; badge?: string }[] = [
  { id: 'tracing', label: 'Tracing' },
  { id: 'evals', label: 'Evals' },
  { id: 'agents', label: 'Agents', badge: 'Pre-Alpha' },
];

export function isPackageId(value: string): value is PackageId {
  return TABS.some((tab) => tab.id === value);
}
