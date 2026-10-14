import path from 'node:path';
import { resolveDocLink } from './links';
import { scanMdx } from './mdx-lines';
import { DOCS_TABS } from './navigation';
import { parseRetrySpec, retryMarkdown } from './retries';
import { topologyMarkdown, walkthroughMarkdown } from './runs/describe';
import { loadRun } from './runs/load';
import { LLMS_TXT_URL, MCP_URL, markdownUrl, pageUrl, SITE_URL } from './site';
import { readSnippet } from './snippets';
import { type DocPage, getAllPages } from './source';

/**
 * Markdown views of the docs for LLMs and coding agents: per-page `.md`, `llms.txt` and
 * `llms-full.txt`. MDX components are flattened into plain Markdown and every link is
 * absolute, so a page still makes sense when pasted on its own.
 */

const SITE_SUMMARY =
  'TypeScript toolkit for AI applications: event-driven, type-safe agent networks (@m4trix/core), ' +
  'evals (@m4trix/evals) and tracing (@m4trix/tracing, @m4trix/trace-viewer).';

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/** A JSX string attribute: `name="v"`, `name='v'` or `name={"v"}`. */
function jsxAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|\\{\\s*(["'])(.*?)\\3\\s*\\})`).exec(
    tag,
  );
  return match ? (match[1] ?? match[2] ?? match[4]) : undefined;
}

const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
/** Self-closing components that expand to generated Markdown. */
const EXPANDED_TAG =
  /<(Snippet|NetworkDiagram|RunPlayer|RunWalkthrough|RetryDiagram)\b([^>]*?)\/>/g;

/** `<Snippet file region title />` → a fenced block with the resolved code. */
async function snippetToMarkdown(attrs: string): Promise<string> {
  const file = jsxAttr(attrs, 'file');
  if (!file) throw new Error(`<Snippet${attrs}/> needs a file`);
  const snippet = await readSnippet(file, jsxAttr(attrs, 'region'));
  const title = jsxAttr(attrs, 'title') ?? path.basename(file);
  const fence = snippet.code.includes('```') ? '~~~~' : '```';
  return `\n${fence}${snippet.lang} title="${title}"\n${snippet.code}\n${fence}\n`;
}

/**
 * `<NetworkDiagram run />` → a bullet list of the topology. `<RunPlayer run />` and
 * `<RunWalkthrough run />` → the numbered walkthrough, once per run and page. A
 * `<RunPlayer region>` also shows code next to the stage, so its Markdown carries that code
 * too: the walkthrough names agents a reader would otherwise never see.
 */
async function runToMarkdown(tag: string, attrs: string, emit: boolean): Promise<string> {
  const id = jsxAttr(attrs, 'run');
  if (!id) throw new Error(`<${tag}${attrs}/> needs a run`);
  const run = await loadRun(id);
  if (tag === 'NetworkDiagram') return `\n${topologyMarkdown(run)}\n`;
  const region = tag === 'RunPlayer' ? jsxAttr(attrs, 'region') : undefined;
  const code = region ? await snippetToMarkdown(` file="${run.snippet}" region="${region}"`) : '';
  return `${code}${emit ? `\n${walkthroughMarkdown(run)}\n` : ''}`;
}

/**
 * Transforms prose, with expanding components (`<Snippet />`, run visuals) replaced by their
 * Markdown. Tags are swapped for placeholders first so the prose transforms still see the
 * surrounding components whole. `walkthroughs` collects runs whose walkthrough the page already
 * has; placeholders are assigned synchronously, in document order.
 */
async function proseToMarkdown(
  text: string,
  slug: string,
  walkthroughs: Set<string>,
): Promise<string> {
  const parts: Promise<string>[] = [];
  const prose = text
    .replace(MDX_COMMENT, '')
    .replace(EXPANDED_TAG, (_, tag: string, attrs: string) => {
      if (tag === 'Snippet') {
        parts.push(snippetToMarkdown(attrs));
      } else if (tag === 'RetryDiagram') {
        parts.push(
          Promise.resolve(`\n${retryMarkdown(parseRetrySpec((n) => jsxAttr(attrs, n)))}\n`),
        );
      } else {
        const id = jsxAttr(attrs, 'run') ?? '';
        const emit = tag !== 'NetworkDiagram' && !walkthroughs.has(id);
        if (emit) walkthroughs.add(id);
        parts.push(runToMarkdown(tag, attrs, emit));
      }
      return `\uE000part:${parts.length - 1}\uE000`;
    });
  const expanded = await Promise.all(parts);
  return transformProse(prose, slug).replace(
    /\uE000part:(\d+)\uE000/g,
    (_, i: string) => expanded[Number(i)],
  );
}

function absoluteLink(href: string, fromSlug: string): string {
  const doc = resolveDocLink(href, fromSlug);
  if (doc) return `${markdownUrl(doc.slug)}${doc.hash}`;
  if (href.startsWith('/')) return `${SITE_URL}${href}`;
  return href;
}

/** Flattens the MDX components used in content into plain Markdown. */
export async function mdxToMarkdown(body: string, slug: string): Promise<string> {
  const out: Array<string | Promise<string>> = [];
  // Code blocks pass through untouched; consecutive prose lines are transformed together so
  // multi-line components are seen whole.
  let prose: string[] = [];
  const walkthroughs = new Set<string>();
  const flushProse = () => {
    if (prose.length) out.push(proseToMarkdown(prose.join('\n'), slug, walkthroughs));
    prose = [];
  };
  for (const line of scanMdx(body)) {
    if (line.kind === 'prose') {
      prose.push(line.text);
    } else {
      flushProse();
      out.push(line.text);
    }
  }
  flushProse();
  return (await Promise.all(out))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function transformProse(text: string, slug: string): string {
  return (
    text
      // Cards → link list items
      .replace(/^[ \t]*<Card\b([^>]*)>([\s\S]*?)<\/Card>/gm, (_, attrs: string, inner: string) => {
        const title = attr(attrs, 'title') ?? '';
        const href = attr(attrs, 'href');
        const text = inner.trim().replace(/\s+/g, ' ');
        const link = href ? `[${title}](${absoluteLink(href, slug)})` : `**${title}**`;
        return `- ${link}${text ? `: ${text}` : ''}`;
      })
      // Changelog entries
      .replace(/<Update\b([^>]*)>/g, (_, attrs: string) => {
        const label = attr(attrs, 'label') ?? '';
        const description = attr(attrs, 'description');
        return `## ${label}${description ? `\n\n_${description}_` : ''}\n`;
      })
      // Callouts → blockquotes
      .replace(
        /<(Note|Tip|Info|Warning|Check)\b[^>]*>([\s\S]*?)<\/\1>/g,
        (_, kind: string, inner: string) =>
          inner
            .trim()
            .split('\n')
            .map((line, i) => `> ${i === 0 ? `**${kind}:** ` : ''}${line.trim()}`)
            .join('\n'),
      )
      // Layout-only wrappers
      .replace(/<\/?(Update|Columns|CodeGroup|Steps)\b[^>]*>/g, '')
      // Links and images
      .replace(
        /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g,
        (_, bang: string, label: string, href: string) =>
          `${bang}[${label}](${absoluteLink(href, slug)})`,
      )
  );
}

export async function pageToMarkdown(page: DocPage): Promise<string> {
  const parts = [
    `> Documentation index for m4trix: ${LLMS_TXT_URL}. Every page is available as Markdown by appending \`.md\` to its URL.`,
    '',
    `# ${page.title}`,
  ];
  if (page.description) parts.push('', `> ${page.description}`);
  parts.push(
    '',
    `Source: ${pageUrl(page.slug)}`,
    '',
    await mdxToMarkdown(page.body, page.slug),
    '',
  );
  return parts.join('\n');
}

export async function buildLlmsTxt(): Promise<string> {
  const pages = new Map((await getAllPages()).map((page) => [page.slug, page]));
  const lines = [
    '# m4trix',
    '',
    `> ${SITE_SUMMARY}`,
    '',
    'Every page below is Markdown. Append `.md` to any docs URL (or send `Accept: text/markdown`) to get the Markdown version.',
    `The complete docs in one file: ${SITE_URL}/llms-full.txt`,
    `MCP server with search and page tools (Streamable HTTP): ${MCP_URL}`,
  ];
  for (const tab of DOCS_TABS) {
    for (const group of tab.groups) {
      lines.push('', `## ${tab.label}: ${group.group}`, '');
      for (const slug of group.pages) {
        const page = pages.get(slug);
        if (!page) continue;
        lines.push(
          `- [${page.title}](${markdownUrl(slug)})${page.description ? `: ${page.description}` : ''}`,
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function buildLlmsFullTxt(): Promise<string> {
  const pages = await getAllPages();
  const header = `# m4trix documentation\n\n> ${SITE_SUMMARY}\n`;
  const sections = await Promise.all(
    pages.map(async (page) =>
      [
        `# ${page.title}`,
        `Source: ${pageUrl(page.slug)}`,
        '',
        await mdxToMarkdown(page.body, page.slug),
      ]
        .join('\n')
        .trim(),
    ),
  );
  const body = sections.join('\n\n---\n\n');
  return `${header}\n${body}\n`;
}
