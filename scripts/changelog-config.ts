/**
 * Shared configuration for changelog generation and package scope checks.
 */

export type ChangelogSection = 'agents' | 'evals' | 'tracing';

export const GITHUB_REPO = 'Pascal-Lohscheidt/m4trix';

/** Map commit scopes (and aliases) to a docs changelog section. */
export const SCOPE_TO_SECTION: Record<string, ChangelogSection> = {
  core: 'agents',
  matrix: 'agents',
  stream: 'agents',
  react: 'agents',
  ui: 'agents',
  evals: 'evals',
  tracing: 'tracing',
  'trace-viewer': 'tracing',
  traceer: 'tracing',
};

export const SCOPE_TO_PATH: Record<string, string> = {
  core: 'packages/core/',
  evals: 'packages/evals/',
  stream: 'packages/stream/',
  react: 'packages/react/',
  tracing: 'packages/tracing/',
  'trace-viewer': 'packages/trace-viewer/',
  ui: 'packages/ui/',
};

/** npm-style release tags — source of truth for published versions (not package.json). */
export const SCOPE_TO_TAG_PREFIX: Record<string, string> = {
  core: '@m4trix/core@',
  evals: '@m4trix/evals@',
  stream: '@m4trix/stream@',
  react: '@m4trix/react@',
  tracing: '@m4trix/tracing@',
  'trace-viewer': '@m4trix/trace-viewer@',
  ui: '@m4trix/ui@',
};

/** Package scopes whose release tags apply to each changelog section. */
export const SECTION_SCOPES: Record<ChangelogSection, string[]> = {
  agents: ['core', 'stream', 'react', 'ui'],
  evals: ['evals'],
  tracing: ['tracing', 'trace-viewer'],
};

export const SECTION_CONFIG: Record<
  ChangelogSection,
  {
    outputPath: string;
    title: string;
    description: string;
    pathPrefixes: string[];
    primaryPackage: string;
    npmPackage: string;
  }
> = {
  agents: {
    outputPath: 'docs/project/changelog.mdx',
    title: 'Changelog',
    description: 'Release notes for @m4trix/core, stream, react, and ui.',
    pathPrefixes: ['packages/core/', 'packages/stream/', 'packages/react/', 'packages/ui/'],
    primaryPackage: 'core',
    npmPackage: '@m4trix/core',
  },
  evals: {
    outputPath: 'docs/evals/changelog.mdx',
    title: 'Changelog',
    description: 'Release notes for @m4trix/evals.',
    pathPrefixes: ['packages/evals/'],
    primaryPackage: 'evals',
    npmPackage: '@m4trix/evals',
  },
  tracing: {
    outputPath: 'docs/tracing/changelog.mdx',
    title: 'Changelog',
    description: 'Release notes for @m4trix/tracing and @m4trix/trace-viewer.',
    pathPrefixes: ['packages/tracing/', 'packages/trace-viewer/'],
    primaryPackage: 'tracing',
    npmPackage: '@m4trix/tracing',
  },
};

/** Conventional commit types included in user-facing changelogs. */
export const CHANGELOG_TYPES = new Set(['feat', 'fix', 'perf', 'refactor']);

export const TYPE_LABELS: Record<string, string> = {
  feat: 'New features',
  fix: 'Bug fixes',
  perf: 'Performance',
  refactor: 'Improvements',
};

export const TYPE_TAGS: Record<string, string> = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Improvements',
};
