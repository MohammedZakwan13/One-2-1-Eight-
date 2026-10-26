import type { Metadata } from 'next';
import { SearchPage } from '@/components/storefront/pages/search-page';

type Props = { searchParams: Promise<{ q?: string | string[] }> };

const firstValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const q = firstValue((await searchParams).q).trim();
  // Search result pages are never indexed; the bare search landing page stays indexable.
  return { title: 'Discover Your Style', alternates: { canonical: '/search' }, ...(q ? { robots: { index: false, follow: true } } : {}) };
}

export default async function Page({ searchParams }: Props) {
  const q = firstValue((await searchParams).q).slice(0, 100);
  return <SearchPage initialQuery={q} />;
}
