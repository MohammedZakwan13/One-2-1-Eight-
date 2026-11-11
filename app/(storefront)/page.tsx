import type { Metadata } from 'next';
import { HomePage } from '@/components/storefront/pages/home-page';
import { getStorefront } from '@/lib/api/queries';
import { serverApi } from '@/lib/api/server';

export async function generateMetadata(): Promise<Metadata> {
  const { settings, heroSlides } = await getStorefront();
  const image = heroSlides[0]?.desktopImage;
  return {
    title: { absolute: settings.seoTitle },
    description: settings.seoDescription,
    alternates: { canonical: '/' },
    openGraph: { type: 'website', title: settings.seoTitle, description: settings.seoDescription, siteName: settings.brandName, url: '/', ...(image ? { images: [{ url: image }] } : {}) },
    twitter: { card: 'summary_large_image', title: settings.seoTitle, description: settings.seoDescription },
  };
}

export default async function Page() {

  const [{ heroSlides, categories, luxeFeature }, featured, latest, luxe] = await Promise.all([
    getStorefront(),
    serverApi.catalog.listProducts({ collection: 'best-sellers', pageSize: 4 }),
    serverApi.catalog.listProducts({ collection: 'new-arrivals', pageSize: 4 }),
    // Existing LUXE definition (active + luxe flag). 200 is the API's page cap; a failure only hides the rail, never the page.
    serverApi.catalog.listProducts({ collection: 'one-2-1-eight-luxe', pageSize: 200 }).catch(() => null),
  ]);
  return <HomePage heroSlides={heroSlides} categories={categories} featured={featured.items} latest={latest.items} luxe={luxe?.items ?? []} luxeFeature={luxeFeature ?? null} />;
}
