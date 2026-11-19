'use client';

import { ArrowRight, ArrowUpRight, CircleHelp, PackageCheck, Truck } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { Footer } from '@/components/storefront/footer';
import { money } from '@/lib/format';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';

export function ReturnsPolicyPage() {
  const { settings } = useStorefrontData();
  const { transition: onTransition } = useUi();
  return <><main className="policy-page"><div className="breadcrumbs"><RouteLink href="/" onClick={onTransition}>Home</RouteLink><span>/</span><span>Shipping & returns</span></div><span className="eyebrow">THE DETAILS MATTER</span><h1>Good service is<br /><em>part of the product.</em></h1><p className="policy-lede">Clear expectations, thoughtful support and no guesswork. Here’s how shipping and returns work.</p><div className="policy-card-grid"><article><Truck size={22} /><span>01 / DELIVERY</span><h2>Shipping</h2><p>Complimentary shipping on orders over {money(settings.freeShippingThreshold)}. Delivery estimates are shown at checkout once we've confirmed your pincode.</p></article><article><PackageCheck size={22} /><span>02 / RETURNS</span><h2>7-day easy returns</h2><p>{settings.returnPolicy}</p></article><article><CircleHelp size={22} /><span>03 / SUPPORT</span><h2>Need a hand?</h2><p>For order, fit or bulk enquiry questions, contact our support team.</p><a href={`mailto:${settings.contactEmail}`}>{settings.contactEmail} <ArrowUpRight size={14} /></a></article></div><RouteLink href="/collections/all" className="button button-dark" onClick={onTransition}>BACK TO SHOPPING <ArrowRight size={16} /></RouteLink></main><Footer /></>;
}
