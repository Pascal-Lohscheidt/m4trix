/** Public URLs used in LLM files, MCP and page actions. */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://m4trix.dev').replace(
  /\/$/,
  '',
);

export const DOCS_URL = `${SITE_URL}/docs`;
export const MCP_URL = `${SITE_URL}/mcp`;
export const LLMS_TXT_URL = `${SITE_URL}/llms.txt`;
export const MCP_SERVER_NAME = 'm4trix-docs';

export const GITHUB_REPO = 'https://github.com/Pascal-Lohscheidt/m4trix';
export const DOCS_SOURCE_DIR = 'website/content/docs';

export function pageUrl(slug: string): string {
  return slug === 'index' ? DOCS_URL : `${DOCS_URL}/${slug}`;
}

/** Raw Markdown for a page. `/docs.md` for the home page. */
export function markdownUrl(slug: string): string {
  return `${pageUrl(slug)}.md`;
}

export function editUrl(slug: string): string {
  return `${GITHUB_REPO}/edit/main/${DOCS_SOURCE_DIR}/${slug}.mdx`;
}
