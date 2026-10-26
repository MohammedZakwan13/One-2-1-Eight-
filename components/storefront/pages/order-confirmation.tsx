'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Clock3, PackageCheck, X } from 'lucide-react';
import { useRuntimeConfig, useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { RouteLink } from '@/components/ui/route-link';
import { Footer } from '@/components/storefront/footer';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { Order, PaymentStatus } from '@/lib/api/schemas';
import { money } from '@/lib/format';

const METHOD_LABEL: Record<Order['paymentMethod'], string> = { upi: 'UPI', card: 'Card', cod: 'Cash on delivery' };
const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  paid: 'Paid', cod_pending: 'Pay on delivery', pending: 'Awaiting confirmation', unpaid: 'Awaiting payment', failed: 'Failed', refunded: 'Refunded',
};

/**
 * Shows what the SERVER knows about the order. It never claims success on its own:
 * only `paid` / `cod_pending` read as a placed order, and pending payments keep polling for the provider's verified result.
 */
export function OrderConfirmation({ orderId, token }: { orderId: string; token: string }) {
  const { settings } = useStorefrontData();
  const { transition: onTransition } = useUi();
  const { mock } = useRuntimeConfig();
  const query = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.orders.get(orderId, token || undefined),
    enabled: Boolean(orderId),
    refetchInterval: current => { const status = current.state.data?.paymentStatus; return status === 'pending' || status === 'unpaid' ? 3000 : false; },
  });
  const order = query.data;

  if (!orderId || (query.isError && isApiError(query.error) && query.error.status === 404)) {
    return <><main className="order-confirmation"><div className="confirmation-mark"><X size={35} /></div><span className="eyebrow">ORDER NOT FOUND</span><h1>We couldn't find<br /><em>that order.</em></h1><p>The link may be incomplete or has expired. If you just placed an order, contact us at {settings.contactEmail} with your order number.</p><div className="confirmation-actions"><RouteLink href="/" className="button button-dark" onClick={onTransition}>BACK HOME <ArrowRight size={16} /></RouteLink></div></main><Footer /></>;
  }
  if (query.isLoading) return <><main className="order-confirmation"><div className="loading-state" role="status"><Clock3 size={28} />Loading your order…</div></main><Footer /></>;
  if (query.isError || !order) {
    return <><main className="order-confirmation"><div className="error-state" role="alert"><p>{errorMessage(query.error)}</p><button className="button button-dark" onClick={() => query.refetch()}>TRY AGAIN</button></div></main><Footer /></>;
  }

  const firstName = order.contact.name.split(' ')[0];
  const placed = order.paymentStatus === 'paid' || order.paymentStatus === 'cod_pending';
  const failed = order.paymentStatus === 'failed';
  const awaiting = order.paymentStatus === 'pending' || order.paymentStatus === 'unpaid';
  const eyebrow = placed ? 'ORDER PLACED' : failed ? 'PAYMENT FAILED' : order.paymentStatus === 'refunded' ? 'ORDER REFUNDED' : 'AWAITING PAYMENT';
  return <><main className="order-confirmation">
    <div className="confirmation-mark">{placed ? <Check size={35} /> : failed ? <X size={35} /> : <Clock3 size={35} />}</div>
    <span className="eyebrow">{eyebrow}</span>
    {placed ? <h1>Good choice.<br /><em>It's all yours.</em></h1> : failed ? <h1>That didn't<br /><em>go through.</em></h1> : <h1>Almost there.<br /><em>Confirming payment.</em></h1>}
    <p>{placed
      ? `Thanks, ${firstName}. ${order.paymentStatus === 'paid' ? 'Your payment has been received.' : 'Please keep the amount ready to pay on delivery.'}`
      : failed
        ? `${firstName}, your payment was not completed. You can go back to your bag and try again.`
        : awaiting
          ? `Thanks, ${firstName}. We haven't received confirmation from your payment provider yet. This page updates automatically.`
          : `This order is ${order.status.replace(/_/g, ' ')}.`}</p>
    <div className="confirmation-receipt"><div><span>ORDER NUMBER</span><strong>{order.number}</strong></div><div><span>ORDER TOTAL</span><strong>{money(order.totals.total)}</strong></div><div><span>PAYMENT</span><strong>{METHOD_LABEL[order.paymentMethod]} · {PAYMENT_LABEL[order.paymentStatus]}</strong></div></div>
    <div className="confirmation-next"><PackageCheck size={20} /><div><strong>{placed ? "You're all set." : 'Need a hand?'}</strong><span>Questions about this order? Write to {settings.contactEmail} and quote order {order.number}.</span></div></div>
    {mock && <p className="dev-note">Development mock order — nothing was charged or shipped.</p>}
    <div className="confirmation-actions">{failed || awaiting ? <RouteLink href="/bag" className="button button-dark" onClick={onTransition}>BACK TO YOUR BAG <ArrowRight size={16} /></RouteLink> : <RouteLink href="/collections/new-arrivals" className="button button-dark" onClick={onTransition}>KEEP EXPLORING <ArrowRight size={16} /></RouteLink>}<RouteLink href="/" className="button button-outline" onClick={onTransition}>BACK HOME</RouteLink></div>
  </main><Footer /></>;
}
