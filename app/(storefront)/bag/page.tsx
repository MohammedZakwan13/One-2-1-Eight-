import type { Metadata } from 'next';
import { BagPage } from '@/components/storefront/pages/bag-page';

export const metadata: Metadata = { title: 'Your Bag', robots: { index: false, follow: false } };

export default function Page() {
  return <BagPage />;
}
