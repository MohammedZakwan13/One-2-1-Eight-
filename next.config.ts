import type { NextConfig } from 'next';
import { securityHeaders } from './lib/security-headers';

const isDev = process.env.NODE_ENV !== 'production';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // `BUILD_STANDALONE=1` produces the minimal server bundle used by the Docker image. Vercel does not need it.
  output: process.env.BUILD_STANDALONE === '1' ? 'standalone' : undefined,
  // Product and campaign imagery is served pre-optimised (WebP) from /public or the CDN configured in the CMS.
  images: { unoptimized: true },
  // The OpenAPI route reads this file at request time, which static tracing cannot see; without it the Vercel function would not contain the file.
  outputFileTracingIncludes: { '/api/v1/openapi.json': ['./openapi/openapi.yaml'] },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders(process.env, isDev) },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      // Public, non-personalised storefront HTML may be cached briefly at the CDN edge (cart/account/checkout are client-fetched and never cached).
      ...['/', '/collections/:slug', '/products/:slug', '/size-guide', '/policies/:slug'].map(source => ({
        source,
        headers: [{ key: 'Cache-Control', value: 'public, s-maxage=60, stale-while-revalidate=300' }],
      })),
      {
        source: '/sitemap.xml',
        headers: [{ key: 'Cache-Control', value: 'public, s-maxage=3600, stale-while-revalidate=86400' }],
      },
    ];
  },
};

export default nextConfig;
