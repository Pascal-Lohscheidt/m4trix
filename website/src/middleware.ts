import { type NextRequest, NextResponse } from 'next/server';

/**
 * LLM-friendly docs URLs:
 * - `/docs/<slug>.md` and `/docs.md` serve the page as Markdown (`/docs/index.md` too, since
 *   tools see the home page's slug as `index`).
 * - A docs page requested with `Accept: text/markdown` (and not text/html) gets Markdown too.
 *   Files under /docs (search.json, visuals) are served as they are.
 * - `/docs/llms.txt` and `/docs/llms-full.txt` alias the site-root files.
 */

function markdownRoute(slug: string, request: NextRequest) {
  const page = slug === 'index' ? '' : slug;
  return NextResponse.rewrite(new URL(`/docs-md${page ? `/${page}` : ''}`, request.url));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === '/docs/llms.txt' || pathname === '/docs/llms-full.txt') {
    return NextResponse.rewrite(new URL(pathname.slice('/docs'.length), request.url));
  }

  if (pathname === '/docs.md' || (pathname.startsWith('/docs/') && pathname.endsWith('.md'))) {
    return markdownRoute(pathname.replace(/^\/docs\/?/, '').replace(/\.md$/, ''), request);
  }

  const accept = request.headers.get('accept') ?? '';
  const isFile = pathname.slice(pathname.lastIndexOf('/') + 1).includes('.');
  if (accept.includes('text/markdown') && !accept.includes('text/html') && !isFile) {
    return markdownRoute(pathname.replace(/^\/docs\/?/, '').replace(/\/$/, ''), request);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/docs', '/docs.md', '/docs/:path*'],
};
