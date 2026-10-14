import { DOCS_SLUGS, docsHref } from './navigation';

const KNOWN = new Set(DOCS_SLUGS);

/** Old Mintlify paths that no longer match a file name. */
const ALIASES: Record<string, string> = {
  README: 'index',
  'guides/next.js': 'guides/nextjs',
};

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Resolves a link written in docs content (`../concepts/events.md`, `/guides/patterns`,
 * `hello-world.md#run`) to a docs page slug. Returns null for anything that is not a docs page.
 */
export function resolveDocLink(
  href: string,
  fromSlug: string,
): { slug: string; hash: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
    return null;
  }
  const hashIndex = href.indexOf('#');
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex);
  let path = hashIndex === -1 ? href : href.slice(0, hashIndex);
  path = path.replace(/\.mdx?$/, '');

  let candidate: string;
  if (path.startsWith('/')) {
    const underDocs = /^\/docs(?=\/|$)/.test(path);
    candidate = normalize(path.replace(/^\/docs(?=\/|$)/, ''));
    // `/docs` is the docs home; `/` is the site's home page, not a docs page.
    if (candidate === '' && !underDocs) return null;
  } else {
    const dir = fromSlug.includes('/') ? fromSlug.slice(0, fromSlug.lastIndexOf('/')) : '';
    candidate = normalize(`${dir}/${path}`);
  }
  if (candidate === '') candidate = 'index';
  candidate = ALIASES[candidate] ?? candidate;
  return KNOWN.has(candidate) ? { slug: candidate, hash } : null;
}

/** Link target for the rendered site. Non-docs links pass through untouched. */
export function rewriteDocHref(href: string, fromSlug: string): string {
  const resolved = resolveDocLink(href, fromSlug);
  return resolved ? `${docsHref(resolved.slug)}${resolved.hash}` : href;
}
