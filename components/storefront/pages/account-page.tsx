'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, PackageCheck } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { Footer } from '@/components/storefront/footer';
import { RouteLink } from '@/components/ui/route-link';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useCustomer } from '@/lib/hooks/use-customer';
import { money } from '@/lib/format';

/** Signed-in customer area: profile basics and order history, straight from the API. */
export function AccountPage() {
  const router = useRouter();
  const { transition: onTransition, notify } = useUi();
  const { customer, isLoading, setCustomer } = useCustomer();
  useEffect(() => { if (!isLoading && !customer) router.replace('/login'); }, [isLoading, customer, router]);
  const orders = useQuery({ queryKey: ['my-orders'], queryFn: () => api.orders.listMine(), enabled: Boolean(customer) });

  const signOut = async () => {
    try { await api.auth.logout(); } catch (error) { notify(errorMessage(error)); return; }
    setCustomer(null);
    notify('You have been signed out.');
    router.replace('/');
  };

  if (isLoading || !customer) return <><main className="policy-page"><div className="loading-state" role="status">Loading your account…</div></main><Footer /></>;
  return <><main className="policy-page">
    <div className="breadcrumbs"><RouteLink href="/" onClick={onTransition}>Home</RouteLink><span>/</span><span>Your account</span></div>
    <span className="eyebrow">YOUR SPACE</span>
    <h1>Your account</h1>
    <p className="policy-lede">Signed in as +91 {customer.phone}{customer.name ? ` · ${customer.name}` : ''}.</p>
    <div className="policy-card-grid">
      {orders.isLoading && <article><span>ORDERS</span><p>Loading your orders…</p></article>}
      {orders.isError && <article><span>ORDERS</span><p role="alert">{errorMessage(orders.error)}</p></article>}
      {orders.data && orders.data.items.length === 0 && <article><PackageCheck size={22} /><span>ORDERS</span><h2>No orders yet</h2><p>When you place an order it will show up here.</p><RouteLink href="/collections/new-arrivals" className="button button-dark" onClick={onTransition}>SHOP NEW ARRIVALS <ArrowRight size={15} /></RouteLink></article>}
      {orders.data?.items.map(order => <article key={order.id}><PackageCheck size={22} /><span>ORDER {order.number}</span><h2>{money(order.totals.total)}</h2><p>{order.lines.length} {order.lines.length === 1 ? 'item' : 'items'} · {order.status.replace(/_/g, ' ')} · {order.paymentStatus.replace(/_/g, ' ')}</p><RouteLink href={`/order-confirmation?order=${encodeURIComponent(order.id)}`} onClick={onTransition} className="text-link">VIEW ORDER</RouteLink></article>)}
    </div>
    <button className="button button-outline" onClick={signOut}>SIGN OUT</button>
  </main><Footer /></>;
}
