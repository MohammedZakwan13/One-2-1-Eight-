import type { Metadata } from 'next';
import { CheckoutPage } from '@/components/storefront/pages/checkout-page';
import { requireCustomerPage } from '@/lib/auth/customer-guard';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false, follow: false } };
// Rendered per request: the guard depends on the visitor's session cookie.
export const dynamic = 'force-dynamic';

export default async function Page() {
  // Checkout is for signed-in customers only (MSG91 OTP). Guests are redirected to /login?returnTo=%2Fcheckout before anything renders.
  await requireCustomerPage('/checkout');
  return <CheckoutPage />;
}
