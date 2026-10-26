import type { Metadata } from 'next';
import { SizeGuidePage } from '@/components/storefront/pages/size-guide-page';

export const metadata: Metadata = { title: 'Size & Fit Guide', alternates: { canonical: '/size-guide' } };

export default function Page() {
  return <SizeGuidePage />;
}
