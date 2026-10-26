'use client';

import { Heart, Menu, Search, ShoppingBag, Sparkles, UserRound } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { RouteLink } from '@/components/ui/route-link';
import type { StoreSettings } from '@/lib/api/schemas';

export function StoreHeader({
  onSearch, onMenu, onTransition, cartCount, wishlistCount, settings,
}: {
  onSearch: () => void; onMenu: () => void; onTransition: () => void; cartCount: number; wishlistCount: number; settings: StoreSettings;
}) {
  return <>
    {settings.announcementEnabled && <div className="announcement"><div className="announcement-track"><span>{settings.promoText}</span><span aria-hidden="true">{settings.promoText}</span><span aria-hidden="true">{settings.promoText}</span></div></div>}
    <header className="site-header">
      <div className="header-mobile-left"><button className="icon-button" onClick={onMenu} aria-label="Open menu"><Menu size={23} strokeWidth={1.7} /></button></div>
      <div className="header-desktop-left"><button className="icon-button" onClick={onMenu} aria-label="Open menu"><Menu size={22} strokeWidth={1.7} /></button><nav className="desktop-nav"><RouteLink href="/collections/new-arrivals" onClick={onTransition}>NEW IN</RouteLink><RouteLink href="/collections/all" onClick={onTransition}>SHOP ALL</RouteLink><RouteLink href="/collections/best-sellers" onClick={onTransition}>BEST SELLERS</RouteLink></nav></div>
      <RouteLink href="/" className="header-logo" onClick={onTransition}><BrandMark /></RouteLink>
      <div className="header-actions">
        <button className="icon-button" aria-label="Search" onClick={onSearch}><Search size={23} strokeWidth={1.65} /></button>
        <RouteLink href="/collections/one-2-1-eight-luxe" className="luxe-nav-link" onClick={onTransition}><Sparkles size={14} /> LUXE</RouteLink>
        <RouteLink href="/wishlist" onClick={onTransition} className="icon-button counted-icon header-wishlist-action"><span className="visually-hidden">Wishlist</span><Heart size={22} strokeWidth={1.55} />{wishlistCount > 0 && <span className="count-bubble">{wishlistCount}</span>}</RouteLink>
        <RouteLink href="/bag" onClick={onTransition} className="icon-button counted-icon"><span className="visually-hidden">Shopping bag</span><ShoppingBag size={22} strokeWidth={1.55} />{cartCount > 0 && <span className="count-bubble">{cartCount}</span>}</RouteLink>
        <RouteLink href="/login" onClick={onTransition} className="icon-button account-action"><span className="visually-hidden">Account</span><UserRound size={22} strokeWidth={1.6} /></RouteLink>
      </div>
    </header>
  </>;
}
