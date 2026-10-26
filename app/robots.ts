import type { MetadataRoute } from 'next';
import { getServerEnv } from '@/lib/env';

export default function robots(): MetadataRoute.Robots {
  const env = getServerEnv();
  // Only production is crawlable; preview/staging/dev deployments are closed to crawlers.
  if (!env.isProduction) return { rules: [{ userAgent: '*', disallow: '/' }] };
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/api/', '/bag', '/checkout', '/account', '/login', '/wishlist', '/order-confirmation', '/search?'] }],
    sitemap: `${env.siteUrl}/sitemap.xml`,
    host: env.siteUrl,
  };
}
