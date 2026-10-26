import type { MetadataRoute } from 'next';
import { getCategories, getCollections, getLegalPage } from '@/lib/api/queries';
import { serverApi } from '@/lib/api/server';
import type { Product } from '@/lib/api/schemas';
import { absoluteUrl } from '@/lib/site';

// Rendered on demand (and CDN-cached via next.config headers) so `next build` never needs the backend.
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

async function allProducts(): Promise<Product[]> {
  const products: Product[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await serverApi.catalog.listProducts({ page, pageSize: PAGE_SIZE });
    products.push(...result.items);
    if (products.length >= result.total || result.items.length === 0) break;
  }
  return products;
}

/** Built from live catalogue data. If the API is unreachable this throws, so crawlers get a 5xx rather than a stale or partial sitemap. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [products, collections, categories, terms, privacy] = await Promise.all([
    allProducts(), getCollections(), getCategories(), getLegalPage('terms'), getLegalPage('privacy'),
  ]);
  const now = new Date();
  const staticPaths = ['/', '/collections/all', '/size-guide', '/policies/returns', ...[terms, privacy].flatMap(page => (page ? [`/policies/${page.slug}`] : []))];
  const collectionPaths = [...collections.items.map(item => item.slug), ...categories.items.filter(item => item.active).map(item => item.slug)].map(slug => `/collections/${slug}`);
  return [
    ...[...staticPaths, ...collectionPaths].map(path => ({ url: absoluteUrl(path), lastModified: now, changeFrequency: 'daily' as const, priority: path === '/' ? 1 : 0.7 })),
    ...products.map(product => ({ url: absoluteUrl(`/products/${product.slug}`), lastModified: new Date(product.updatedAt), changeFrequency: 'weekly' as const, priority: 0.65 })),
  ];
}
