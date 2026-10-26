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
  const [{ heroSlides, categories }, featured, latest] = await Promise.all([
    getStorefront(),
    serverApi.catalog.listProducts({ collection: 'best-sellers', pageSize: 4 }),
    serverApi.catalog.listProducts({ collection: 'new-arrivals', pageSize: 4 }),
  ]);
  return <HomePage heroSlides={heroSlides} categories={categories} featured={featured.items} latest={latest.items} />;
}
