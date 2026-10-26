'use client';

import { ArrowRight, ArrowUpRight, ShieldCheck, Sparkles, Truck, X } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { RouteLink } from '@/components/ui/route-link';
import type { Category } from '@/lib/api/schemas';
import { isStorefrontCategory } from '@/lib/catalog';

export function SideMenu({ open, close, categories, onTransition }: { open: boolean; close: () => void; categories: Category[]; onTransition: () => void }) {
  if (!open) return null;
  return <div className="overlay-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <aside className="menu-drawer" aria-label="Shop navigation">
      <div className="drawer-top"><BrandMark small /><button className="icon-button" onClick={close} aria-label="Close menu"><X /></button></div>
      <div className="menu-intro"><span>THE 1218 EDIT</span><h2>Wear your own standard.</h2><p>Considered essentials, built for the everyday.</p></div>
      <div className="menu-group-title">DISCOVER</div>
      <RouteLink className="menu-link menu-link-feature" href="/collections/one-2-1-eight-luxe" onClick={() => { close(); onTransition(); }}><Sparkles size={17} /> ONE 2 1 EIGHT LUXE <ArrowUpRight size={17} /></RouteLink>
      <RouteLink className="menu-link" href="/collections/new-arrivals" onClick={() => { close(); onTransition(); }}>New arrivals <ArrowRight size={16} /></RouteLink>
      <RouteLink className="menu-link" href="/collections/best-sellers" onClick={() => { close(); onTransition(); }}>Best sellers <ArrowRight size={16} /></RouteLink>
      <RouteLink className="menu-link" href="/collections/all" onClick={() => { close(); onTransition(); }}>Shop all <ArrowRight size={16} /></RouteLink>
      <div className="menu-group-title menu-category-title">SHOP BY CATEGORY</div>
      <div className="menu-categories">{categories.filter(isStorefrontCategory).map(cat => <RouteLink href={`/collections/${cat.slug}`} key={cat.id} onClick={() => { close(); onTransition(); }}>{cat.name}<ArrowUpRight size={14} /></RouteLink>)}</div>
      <div className="menu-drawer-bottom"><span><Truck size={17} /> Complimentary shipping over ₹1,499</span><span><ShieldCheck size={17} /> 7-day easy returns</span></div>
    </aside>
  </div>;
}
