/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
  // Shared docs visuals ship as TypeScript + CSS source from the workspace.
  transpilePackages: ['docs-visual-gen'],
  experimental: {
    // Twoslash runs the TypeScript language service on the server (`<Snippet />`); its
    // virtual file system needs Node's own `require`, so it must not be bundled.
    serverComponentsExternalPackages: ['@shikijs/twoslash'],
    // The MCP route reads docs at request time; ship the MDX sources (and the snippets and
    // recorded runs `<Snippet />`, `<NetworkDiagram />` and `<RunPlayer />` expand to in
    // Markdown) with it.
    outputFileTracingIncludes: {
      '/mcp': ['./content/docs/**/*', './content/snippets/**/*', './content/runs/**/*'],
    },
  },
  async redirects() {
    return [
      // The docs used to live on Mintlify at docs.m4trix.dev with the same page paths.
      {
        source: '/llms.txt',
        has: [{ type: 'host', value: 'docs.m4trix.dev' }],
        destination: 'https://m4trix.dev/llms.txt',
        permanent: true,
      },
      {
        source: '/llms-full.txt',
        has: [{ type: 'host', value: 'docs.m4trix.dev' }],
        destination: 'https://m4trix.dev/llms-full.txt',
        permanent: true,
      },
      {
        source: '/mcp',
        has: [{ type: 'host', value: 'docs.m4trix.dev' }],
        destination: 'https://m4trix.dev/mcp',
        permanent: false,
      },
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'docs.m4trix.dev' }],
        destination: 'https://m4trix.dev/docs/:path*',
        permanent: true,
      },
      // Mintlify tab roots and renamed pages.
      { source: '/docs/evals', destination: '/docs/evals/overview', permanent: true },
      { source: '/docs/tracing', destination: '/docs/tracing/overview', permanent: true },
      { source: '/docs/guides/next.js', destination: '/docs/guides/nextjs', permanent: true },
      { source: '/docs/README', destination: '/docs', permanent: true },
      { source: '/docs/index', destination: '/docs', permanent: true },
    ];
  },
};

export default nextConfig;
