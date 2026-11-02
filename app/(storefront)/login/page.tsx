import type { Metadata } from 'next';
import { LoginPage } from '@/components/storefront/pages/login-page';
import { safeReturnTo } from '@/lib/return-to';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const raw = (await searchParams).returnTo;
  return <LoginPage returnTo={safeReturnTo(Array.isArray(raw) ? raw[0] : raw)} />;
}
