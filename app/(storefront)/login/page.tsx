import type { Metadata } from 'next';
import { LoginPage } from '@/components/storefront/pages/login-page';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false, follow: false } };

export default function Page() {
  return <LoginPage />;
}
