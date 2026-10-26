import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MockPaymentPage } from '@/components/storefront/pages/mock-payment-page';
import { getServerEnv } from '@/lib/env';

export const metadata: Metadata = { title: 'Mock payment', robots: { index: false, follow: false } };

type Props = { params: Promise<{ paymentId: string }>; searchParams: Promise<{ order?: string; token?: string }> };

export default async function Page({ params, searchParams }: Props) {
  // Hard stop: this page only exists in development / test mock mode.
  if (!getServerEnv().mockEnabled) notFound();
  const { paymentId } = await params;
  const { order = '', token = '' } = await searchParams;
  return <MockPaymentPage paymentId={paymentId} orderId={order} token={token} />;
}
