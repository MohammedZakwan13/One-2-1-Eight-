'use client';

import { Heart, Menu, ShoppingBag, UserRound, Zap } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';

export function MobileBottomNav({ onTransition, cartCount, wishlistCount }: { onTransition: () => void; cartCount: number; wishlistCount: number }) {
  return <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
    <RouteLink href="/" onClick={onTransition}><span className="nav-mini-icon"><Zap size={19} /></span><small>Home</small></RouteLink>
    <RouteLink href="/collections/all" onClick={onTransition}><span className="nav-mini-icon"><Menu size={19} /></span><small>Shop</small></RouteLink>
    <RouteLink href="/wishlist" onClick={onTransition} className="mini-count-wrap"><span className="nav-mini-icon"><Heart size={19} />{wishlistCount > 0 && <i>{wishlistCount}</i>}</span><small>Saved</small></RouteLink>
    <RouteLink href="/bag" onClick={onTransition} className="mini-count-wrap"><span className="nav-mini-icon"><ShoppingBag size={19} />{cartCount > 0 && <i>{cartCount}</i>}</span><small>Bag</small></RouteLink>
    <RouteLink href="/login" onClick={onTransition}><span className="nav-mini-icon"><UserRound size={19} /></span><small>You</small></RouteLink>
  </nav>;
}
