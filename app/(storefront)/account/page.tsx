import type { Metadata } from 'next';
import { AccountPage } from '@/components/storefront/pages/account-page';

export const metadata: Metadata = { title: 'Your account', robots: { index: false, follow: false } };

export default function Page() {
  return <AccountPage />;
}
