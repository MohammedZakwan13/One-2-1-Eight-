import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductDetailPage } from '@/components/storefront/pages/product-detail-page';
import { getProduct, getStorefront } from '@/lib/api/queries';
import { serverApi } from '@/lib/api/server';
import type { Product, ReviewList } from '@/lib/api/schemas';
import { absoluteUrl, getSiteUrl, jsonLd } from '@/lib/site';
import { productShareUrl } from '@/lib/product-share';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return { title: 'Product not found', robots: { index: false } };
  const { settings, heroSlides } = await getStorefront();
  const image = product.images[0] || heroSlides[0]?.desktopImage || ''; // a product without a photo still gets a branded preview image
  const description = `${product.description} Shop ${product.name} online from ${settings.brandName}.`.trim().slice(0, 300);
  const shareDescription = product.description.trim() || description; // a product without a written description still shares with a useful line
  return {
    title: product.name, description, alternates: { canonical: `/products/${product.slug}` },
    openGraph: { type: 'website', siteName: settings.brandName, title: `${product.name} | ${settings.brandName}`, description: shareDescription, url: `/products/${product.slug}`, ...(image ? { images: [{ url: image, alt: product.name }] } : {}) },
    twitter: { card: 'summary_large_image', title: `${product.name} | ${settings.brandName}`, description: shareDescription, ...(image ? { images: [image] } : {}) },
    other: { 'product:price:amount': String(product.price), 'product:price:currency': 'INR' },
  };
}

function productJsonLd(product: Product, brand: string, reviewCount: number) {
  const inStock = product.variants.some(variant => variant.availability.status !== 'out_of_stock');
  return {
    '@context': 'https://schema.org', '@type': 'Product', name: product.name, description: product.description,
    image: product.images.map(image => (image.startsWith('http') ? image : absoluteUrl(image))),
    brand: { '@type': 'Brand', name: brand }, category: product.category, sku: product.variants[0]?.sku, color: product.color, material: product.material,
    offers: {
      '@type': 'Offer', url: absoluteUrl(`/products/${product.slug}`), priceCurrency: 'INR', price: product.price,
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', itemCondition: 'https://schema.org/NewCondition',
    },
    // Only real, published reviews are ever exposed to search engines.
    ...(reviewCount > 0 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: product.rating, reviewCount } } : {}),
  };
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();
  const [{ settings }, related, reviews] = await Promise.all([
    getStorefront(),
    serverApi.catalog.related(slug, 4),
    // Reviews are non-critical: if they fail the page still renders and the client retries.
    serverApi.reviews.list(slug).catch((error): ReviewList | null => { console.error('[pdp] reviews unavailable', error instanceof Error ? error.message : error); return null; }),
  ]);
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: absoluteUrl('/') },
      { '@type': 'ListItem', position: 2, name: product.category, item: absoluteUrl(`/collections/${product.categorySlug}`) },
      { '@type': 'ListItem', position: 3, name: product.name, item: absoluteUrl(`/products/${product.slug}`) },
    ],
  };
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(productJsonLd(product, settings.brandName, reviews?.summary.count ?? 0)) }} />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumb) }} />
    <ProductDetailPage product={product} related={related.items} initialReviews={reviews} canonicalUrl={productShareUrl(getSiteUrl(), product.slug)} />
  </>;
}
