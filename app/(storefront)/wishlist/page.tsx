import type { Metadata } from 'next';
import { WishlistPage } from '@/components/storefront/pages/wishlist-page';

export const metadata: Metadata = { title: 'Your Wishlist', robots: { index: false, follow: false } };

export default function Page() {
  return <WishlistPage />;
}
