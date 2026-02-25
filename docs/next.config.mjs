/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
  async redirects() {
    return [
      { source: '/docs', destination: 'https://docs.m4trix.dev', permanent: true },
      { source: '/docs/:path*', destination: 'https://docs.m4trix.dev', permanent: true },
    ]
  },
}

export default nextConfig
