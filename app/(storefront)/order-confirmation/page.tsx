import type { Metadata } from 'next';
import { OrderConfirmation } from '@/components/storefront/pages/order-confirmation';

export const metadata: Metadata = { title: 'Order status', robots: { index: false, follow: false } };

type Props = { searchParams: Promise<{ order?: string; token?: string }> };

export default async function Page({ searchParams }: Props) {
  const { order = '', token = '' } = await searchParams;
  return <OrderConfirmation orderId={order.slice(0, 128)} token={token.slice(0, 256)} />;
}
