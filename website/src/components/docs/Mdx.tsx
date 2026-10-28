import { LinkSimpleIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { MDXRemote } from 'next-mdx-remote/rsc';
import {
  Children,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  isValidElement,
  type ReactNode,
} from 'react';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { rewriteDocHref } from '@/lib/docs/links';
import { Callout, Check, Info, Note, Tip, Warning } from './Callout';
import { Card, Columns } from './Cards';
import { CodeFrame, langLabel, Pre, readCodeInfo } from './CodeBlock';
import { CodeTabs } from './CodeTabs';
import { GraphicFrame } from './GraphicFrame';
import { RetryDiagram } from './RetryDiagram';
import { NetworkDiagram } from './run/NetworkDiagram';
import { RunPlayer } from './run/RunPlayer';
import { RunWalkthrough } from './run/RunWalkthrough';
import { Snippet } from './Snippet';
import { Update } from './Update';

type MdastNode = {
  type: string;
  meta?: string | null;
  data?: { hProperties?: Record<string, unknown> };
  children?: MdastNode[];
};

/** Keeps fence meta (```ts title="x.ts") on the `<code>` element as `data-meta`. */
function remarkCodeMeta() {
  const walk = (node: MdastNode) => {
    if (node.type === 'code' && node.meta) {
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, 'data-meta': node.meta },
      };
    }
    node.children?.forEach(walk);
  };
  return (tree: MdastNode) => walk(tree);
}

function heading(Tag: 'h2' | 'h3' | 'h4') {
  return function Heading({ id, children }: { id?: string; children?: ReactNode }) {
    return (
      <Tag id={id} className="docs-heading">
        {children}
        {id ? (
          <a href={`#${id}`} className="docs-heading-anchor" aria-label="Link to this section">
            <LinkSimpleIcon aria-hidden className="h-4 w-4" />
          </a>
        ) : null}
      </Tag>
    );
  };
}

/** Tabbed group of fenced code blocks; each block's `title="…"` becomes its tab label. */
function CodeGroup({ children }: { children: ReactNode }) {
  const blocks = Children.toArray(children)
    .map(readCodeInfo)
    .filter((info) => info !== null);
  return (
    <CodeTabs
      labels={blocks.map((block) => block.title ?? langLabel(block.lang))}
      codes={blocks.map((block) => block.code)}
    >
      {blocks.map((block) => (
        <CodeFrame key={block.title ?? block.code} {...block} bare />
      ))}
    </CodeTabs>
  );
}

/** Docs images (GIFs and PNGs from docs-visual-gen) sit in the same glass frame as diagrams. */
function DocImage({ alt = '', ...props }: ComponentPropsWithoutRef<'img'>) {
  return (
    <GraphicFrame label="image">
      {/* next/image would re-encode the GIFs. */}
      {/* biome-ignore lint/performance/noImgElement: see above */}
      <img alt={alt} loading="lazy" decoding="async" className="docs-img" {...props} />
    </GraphicFrame>
  );
}

/** A paragraph holding only an image renders as the framed image alone (a frame can't sit in a <p>). */
function DocParagraph({ children, ...props }: ComponentPropsWithoutRef<'p'>) {
  const items = Children.toArray(children).filter(
    (child) => !(typeof child === 'string' && child.trim() === ''),
  );
  if (items.length === 1 && isValidElement(items[0]) && items[0].type === DocImage) {
    return <>{items[0]}</>;
  }
  return <p {...props}>{children}</p>;
}

function components(slug: string) {
  return {
    pre: Pre,
    h2: heading('h2'),
    h3: heading('h3'),
    h4: heading('h4'),
    a: ({ href = '', children, ...rest }: ComponentPropsWithoutRef<'a'>) => {
      const target = rewriteDocHref(href, slug);
      if (target.startsWith('/') || target.startsWith('#')) {
        return (
          <Link href={target} {...rest}>
            {children}
          </Link>
        );
      }
      return (
        <a href={target} target="_blank" rel="noreferrer" {...rest}>
          {children}
        </a>
      );
    },
    p: DocParagraph,
    img: DocImage,
    table: (props: ComponentPropsWithoutRef<'table'>) => (
      <div className="docs-table">
        <table {...props} />
      </div>
    ),
    Callout,
    // Card hrefs use the same Mintlify-style paths as Markdown links (`/concepts/events`).
    Card: ({ href, ...props }: ComponentProps<typeof Card>) => (
      <Card {...props} href={href ? rewriteDocHref(href, slug) : undefined} />
    ),
    Check,
    CodeGroup,
    Columns,
    Info,
    NetworkDiagram,
    Note,
    RetryDiagram,
    RunPlayer,
    RunWalkthrough,
    Snippet,
    Tip,
    Update,
    Warning,
  };
}

export function Mdx({ source, slug }: { source: string; slug: string }) {
  return (
    <MDXRemote
      source={source}
      components={components(slug)}
      options={{
        // The docs are our own content and pass props as expressions (`tags={[...]}`), which
        // v6 strips by default. `blockDangerousJS` stays on.
        blockJS: false,
        mdxOptions: {
          remarkPlugins: [remarkGfm, remarkCodeMeta],
          rehypePlugins: [rehypeSlug],
        },
      }}
    />
  );
}
