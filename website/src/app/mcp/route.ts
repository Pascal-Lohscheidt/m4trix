import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { resolveDocLink } from '@/lib/docs/links';
import { buildLlmsTxt, pageToMarkdown } from '@/lib/docs/llm';
import { buildSearchRecords } from '@/lib/docs/search';
import { excerpt, type SearchRecord, searchRecords } from '@/lib/docs/search-core';
import { DOCS_URL, MCP_SERVER_NAME, markdownUrl, SITE_URL } from '@/lib/docs/site';
import { getPage } from '@/lib/docs/source';

/**
 * Public, read-only MCP server for the docs (Streamable HTTP, stateless: every POST gets a
 * fresh protocol server). Content is read from `content/docs`, which `next.config.mjs` traces
 * into this function.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let records: Promise<SearchRecord[]> | undefined;
const getRecords = () => {
  if (!records) {
    records = buildSearchRecords();
    // Don't keep a failed build: the next call retries instead of failing until a cold start.
    records.catch(() => {
      records = undefined;
    });
  }
  return records;
};

/** Accepts a slug, a docs path or a full docs URL, with or without `.md`. */
function toSlug(input: string): string | null {
  const path = input
    .trim()
    .replace(SITE_URL, '')
    .replace(/^https?:\/\/[^/]+/, '');
  return resolveDocLink(path.startsWith('/') ? path : `/${path}`, 'index')?.slug ?? null;
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: '1.0.0' },
    {
      instructions:
        'Search and read the m4trix docs (agents with @m4trix/core, evals, tracing). ' +
        'Use search_docs to find sections, then get_page for the full Markdown of a page.',
    },
  );

  server.registerTool(
    'search_docs',
    {
      title: 'Search m4trix docs',
      description:
        'Full-text search over every docs section. Returns matching sections with their page, ' +
        'a Markdown URL and an excerpt. Follow up with get_page to read a whole page.',
      inputSchema: {
        query: z.string().min(1).describe('What to look for, e.g. "endsOn terminal event"'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const hits = searchRecords(await getRecords(), query, limit ?? 8);
      if (!hits.length) {
        return { content: [{ type: 'text', text: `No docs sections match "${query}".` }] };
      }
      const text = hits
        .map(({ record }, i) => {
          const anchor = record.href.includes('#')
            ? record.href.slice(record.href.indexOf('#'))
            : '';
          return [
            `${i + 1}. ${record.tab} / ${record.pageTitle}${record.heading ? ` > ${record.heading}` : ''}`,
            `   page: ${record.slug}`,
            `   url: ${markdownUrl(record.slug)}${anchor}`,
            `   ${excerpt(record.text, query, 280)}`,
          ].join('\n');
        })
        .join('\n\n');
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'get_page',
    {
      title: 'Read a docs page',
      description:
        'Returns the full Markdown of one docs page. Accepts a page slug from search_docs or ' +
        `list_pages (e.g. "concepts/events"), a path, or a URL under ${DOCS_URL}.`,
      inputSchema: {
        page: z.string().min(1).describe('Slug, path or URL of the page'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ page }) => {
      const slug = toSlug(page);
      if (!slug) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `No docs page "${page}". Use list_pages to see every page.` },
          ],
        };
      }
      return { content: [{ type: 'text', text: await pageToMarkdown(await getPage(slug)) }] };
    },
  );

  server.registerTool(
    'list_pages',
    {
      title: 'List docs pages',
      description: 'The docs index (llms.txt): every page with its Markdown URL and summary.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text', text: await buildLlmsTxt() }] }),
  );

  return server;
}

async function handle(request: Request): Promise<Response> {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

export async function POST(request: Request) {
  return handle(request);
}

/** Stateless server: no standalone SSE stream. Browsers get a short description instead. */
export async function GET(request: Request) {
  if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  return Response.json({
    name: MCP_SERVER_NAME,
    transport: 'streamable-http',
    url: `${SITE_URL}/mcp`,
    tools: ['search_docs', 'get_page', 'list_pages'],
    install: {
      claudeCode: `claude mcp add --transport http ${MCP_SERVER_NAME} ${SITE_URL}/mcp`,
      cursor: { mcpServers: { [MCP_SERVER_NAME]: { url: `${SITE_URL}/mcp` } } },
    },
  });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
