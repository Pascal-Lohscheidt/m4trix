import { pageToMarkdown } from '@/lib/docs/llm';
import { DOCS_SLUGS } from '@/lib/docs/navigation';
import { getPage, isDocSlug } from '@/lib/docs/source';

/**
 * Raw Markdown for a docs page. Reached through the middleware: `/docs/<slug>.md`,
 * `/docs.md`, or a docs URL requested with `Accept: text/markdown`.
 */

type Params = { slug?: string[] };

export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return DOCS_SLUGS.map((slug) => ({ slug: slug === 'index' ? [] : slug.split('/') }));
}

export async function GET(_request: Request, { params }: { params: Params }) {
  const slug = params.slug?.length ? params.slug.join('/') : 'index';
  if (!isDocSlug(slug)) return new Response('Not found', { status: 404 });
  return new Response(await pageToMarkdown(await getPage(slug)), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Robots-Tag': 'noindex',
    },
  });
}
