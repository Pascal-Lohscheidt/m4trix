import GithubSlugger from 'github-slugger';
import { mdxToMarkdown } from './llm';
import { scanMdx } from './mdx-lines';
import { docsHref, findTab } from './navigation';
import type { SearchRecord } from './search-core';
import { getAllPages, inlineToText } from './source';

const MAX_SECTION_TEXT = 1200;

function toText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\|/g, ' ')
    .split('\n')
    .map(inlineToText)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One record per page section (intro + every heading), anchored like the rendered page. */
export async function buildSearchRecords(): Promise<SearchRecord[]> {
  const records: SearchRecord[] = [];
  for (const page of await getAllPages()) {
    const tab = findTab(page.slug).label;
    const href = docsHref(page.slug);
    const slugger = new GithubSlugger();
    let heading: string | undefined;
    let anchor: string | undefined;
    let buffer: string[] = [];

    const flush = async () => {
      const markdown = await mdxToMarkdown(buffer.join('\n'), page.slug);
      const text = toText(markdown).slice(0, MAX_SECTION_TEXT);
      // The intro record is always kept so every page is findable by title.
      if (text || heading || anchor === undefined) {
        records.push({
          id: `${page.slug}#${anchor ?? ''}`,
          slug: page.slug,
          href: anchor ? `${href}#${anchor}` : href,
          tab,
          pageTitle: page.title,
          heading,
          text,
        });
      }
      buffer = [];
    };

    for (const line of scanMdx(page.body)) {
      if (line.heading) {
        await flush();
        heading = inlineToText(line.heading.raw);
        anchor = slugger.slug(heading);
        continue;
      }
      buffer.push(line.text);
    }
    await flush();
    if (page.description) {
      const intro = records.find((r) => r.id === `${page.slug}#`);
      if (intro) intro.text = `${page.description} ${intro.text}`.trim();
    }
  }
  return records;
}
