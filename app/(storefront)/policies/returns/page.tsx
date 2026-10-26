import type { Metadata } from 'next';
import { ReturnsPolicyPage } from '@/components/storefront/pages/returns-policy-page';

export const metadata: Metadata = { title: 'Shipping & Returns', alternates: { canonical: '/policies/returns' } };

export default function Page() {
  return <ReturnsPolicyPage />;
}
