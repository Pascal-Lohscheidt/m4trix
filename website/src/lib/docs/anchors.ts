import GithubSlugger from 'github-slugger';

/** Anchor for a changelog entry, e.g. "October 9, 2026" → "update-october-9-2026". */
export function updateId(label: string): string {
  return `update-${new GithubSlugger().slug(label)}`;
}
