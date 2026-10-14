import fs from 'node:fs/promises';
import path from 'node:path';
import GithubSlugger from 'github-slugger';
import { updateId } from './anchors';
import { scanMdx } from './mdx-lines';
import { DOCS_SLUGS } from './navigation';

/**
 * Reads docs pages from `content/docs`. Server only (uses the filesystem); route handlers
 * that read at request time list this folder in `outputFileTracingIncludes`.
 */

export const CONTENT_DIR = path.join(process.cwd(), 'content/docs');

export interface DocHeading {
  depth: number;
  text: string;
  id: string;
}

export interface DocPage {
  slug: string;
  title: string;
  sidebarTitle: string;
  description?: string;
  /** MDX source without frontmatter. */
  body: string;
  /** h2 / h3 headings (and changelog entries) for the table of contents. */
  toc: DocHeading[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

/** Frontmatter here is flat `key: value` pairs, so a full YAML parser is not needed. */
function splitFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) data[pair[1]] = unquote(pair[2]);
  }
  return { data, body: source.slice(match[0].length) };
}

/** Plain text of inline Markdown, matching what rehype-slug sees in the rendered heading. */
export function inlineToText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim();
}

const UPDATE_LABEL = /^<Update\b[^>]*\blabel="([^"]+)"/;

function extractToc(body: string): DocHeading[] {
  const slugger = new GithubSlugger();
  const toc: DocHeading[] = [];
  let inUpdate = false;
  for (const line of scanMdx(body)) {
    if (line.kind !== 'prose') continue;

    const update = UPDATE_LABEL.exec(line.text);
    if (update) {
      inUpdate = true;
      toc.push({ depth: 2, text: update[1], id: updateId(update[1]) });
      continue;
    }
    if (line.text.startsWith('</Update>')) {
      inUpdate = false;
      continue;
    }

    if (!line.heading) continue;
    const { depth } = line.heading;
    const text = inlineToText(line.heading.raw);
    // Every heading takes a slug (to keep ids in sync with rehype-slug), but only h2 / h3
    // outside changelog entries go into the table of contents.
    const id = slugger.slug(text);
    if (!inUpdate && (depth === 2 || depth === 3)) toc.push({ depth, text, id });
  }
  return toc;
}

const cache = new Map<string, Promise<DocPage>>();

async function loadPage(slug: string): Promise<DocPage> {
  const source = await fs.readFile(path.join(CONTENT_DIR, `${slug}.mdx`), 'utf8');
  const { data, body } = splitFrontmatter(source);
  const title = data.title ?? slug;
  return {
    slug,
    title,
    sidebarTitle: data.sidebarTitle ?? title,
    description: data.description || undefined,
    body,
    toc: extractToc(body),
  };
}

export function getPage(slug: string): Promise<DocPage> {
  if (process.env.NODE_ENV === 'development') return loadPage(slug);
  let page = cache.get(slug);
  if (!page) {
    page = loadPage(slug);
    cache.set(slug, page);
    // A failed read must not stick: drop it so the next request retries.
    page.catch(() => cache.delete(slug));
  }
  return page;
}

export function isDocSlug(slug: string): boolean {
  return DOCS_SLUGS.includes(slug);
}

export function getAllPages(): Promise<DocPage[]> {
  return Promise.all(DOCS_SLUGS.map(getPage));
}
