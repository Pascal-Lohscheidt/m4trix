import { ArrowLeftIcon, ArrowRightIcon, PencilSimpleIcon } from '@phosphor-icons/react/dist/ssr';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Mdx } from '@/components/docs/Mdx';
import { PageActions } from '@/components/docs/PageActions';
import { Toc } from '@/components/docs/Toc';
import { DOCS_SLUGS, docsHref, findGroup, findTab, siblings } from '@/lib/docs/navigation';
import { editUrl, markdownUrl, pageUrl } from '@/lib/docs/site';
import { getPage, isDocSlug } from '@/lib/docs/source';

type Params = { slug?: string[] };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return DOCS_SLUGS.map((slug) => ({ slug: slug === 'index' ? [] : slug.split('/') }));
}

function toSlug(params: Params): string {
  return params.slug?.length ? params.slug.join('/') : 'index';
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const slug = toSlug(params);
  if (!isDocSlug(slug)) return {};
  const page = await getPage(slug);
  const tab = findTab(slug);
  return {
    title: slug === 'index' ? { absolute: 'm4trix docs' } : `${page.title} (${tab.label})`,
    description: page.description,
    alternates: {
      canonical: pageUrl(slug),
      types: { 'text/markdown': markdownUrl(slug) },
    },
    openGraph: { title: page.title, description: page.description, url: pageUrl(slug) },
  };
}

async function PagerLink({ slug, direction }: { slug?: string; direction: 'prev' | 'next' }) {
  if (!slug) return <span />;
  const page = await getPage(slug);
  const next = direction === 'next';
  return (
    <Link
      href={docsHref(slug)}
      className={`docs-pager ${next ? 'text-right' : ''}`}
      rel={direction}
    >
      <span className={`docs-pager-dir ${next ? 'justify-end' : ''}`}>
        {next ? null : <ArrowLeftIcon aria-hidden className="h-3.5 w-3.5" />}
        {next ? 'Next' : 'Previous'}
        {next ? <ArrowRightIcon aria-hidden className="h-3.5 w-3.5" /> : null}
      </span>
      <span className="docs-pager-title">{page.sidebarTitle}</span>
    </Link>
  );
}

export default async function DocPage({ params }: { params: Params }) {
  const slug = toSlug(params);
  if (!isDocSlug(slug)) notFound();
  const page = await getPage(slug);
  const group = findGroup(slug);
  const { prev, next } = siblings(slug);
  const mdPath = slug === 'index' ? '/docs.md' : `/docs/${slug}.md`;

  return (
    <div className="docs-page">
      <article className="docs-article">
        <header className="docs-page-head">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            {group ? <p className="docs-eyebrow">{group.group}</p> : <span />}
            <PageActions markdownPath={mdPath} markdownUrl={markdownUrl(slug)} />
          </div>
          <h1 className="docs-title">{page.title}</h1>
          {page.description ? <p className="docs-lead">{page.description}</p> : null}
        </header>

        <div className="docs-prose">
          <Mdx source={page.body} slug={slug} />
        </div>

        <footer className="docs-page-foot">
          <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-text-3">
            <a href={editUrl(slug)} className="docs-foot-link" target="_blank" rel="noreferrer">
              <PencilSimpleIcon aria-hidden className="h-3.5 w-3.5" />
              Edit this page on GitHub
            </a>
            <a href={mdPath} className="docs-foot-link">
              View as Markdown
            </a>
          </div>
          <nav aria-label="Pagination" className="docs-pager-row">
            <PagerLink slug={prev} direction="prev" />
            <PagerLink slug={next} direction="next" />
          </nav>
        </footer>
      </article>

      <aside className="docs-toc-col" aria-label="Table of contents">
        <div className="docs-toc-sticky">
          <Toc items={page.toc} />
        </div>
      </aside>
    </div>
  );
}
