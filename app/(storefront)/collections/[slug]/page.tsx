import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CollectionPage } from '@/components/storefront/pages/collection-page';
import { getCategories, getCollections, getStorefront } from '@/lib/api/queries';
import { serverApi } from '@/lib/api/server';
import { absoluteUrl, jsonLd } from '@/lib/site';

type Props = { params: Promise<{ slug: string }> };

/** Resolves a URL slug to either a curated collection, a category, or the full catalogue. */
async function resolve(slug: string) {
  if (slug === 'all') return { title: 'Shop all', kind: 'all' as const };
  const [collections, categories] = await Promise.all([getCollections(), getCategories()]);
  const collection = collections.items.find(item => item.slug === slug);
  if (collection) return { title: collection.title, kind: 'collection' as const };
  const category = categories.items.find(item => item.slug === slug && item.active);
  if (category) return { title: category.name, kind: 'category' as const };
  return null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolve(slug);
  if (!resolved) return { title: 'Not found', robots: { index: false } };
  const { settings } = await getStorefront();
  const description = `Shop ${resolved.title.toLowerCase()} from ${settings.brandName}. Premium fits, refined textures and considered everyday menswear.`;
  return {
    title: resolved.title, description, alternates: { canonical: `/collections/${slug}` },
    openGraph: { title: `${resolved.title} | ${settings.brandName}`, description, url: `/collections/${slug}` },
  };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const resolved = await resolve(slug);
  if (!resolved) notFound();
  const products = await serverApi.catalog.listProducts({
    collection: resolved.kind === 'collection' ? slug : undefined,
    category: resolved.kind === 'category' ? slug : undefined,
    pageSize: 200,
  });
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: absoluteUrl('/') },
      { '@type': 'ListItem', position: 2, name: resolved.title, item: absoluteUrl(`/collections/${slug}`) },
    ],
  };
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumb) }} />
    <CollectionPage slug={slug} title={resolved.title} products={products.items} />
  </>;
}
