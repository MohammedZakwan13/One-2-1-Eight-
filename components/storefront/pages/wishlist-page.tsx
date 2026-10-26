'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Heart, Sparkles, X } from 'lucide-react';
import { useUi } from '@/components/providers/app-providers';
import { useWishlist } from '@/lib/hooks/use-wishlist';
import { useWishlistToggle } from '@/lib/hooks/use-wishlist-toggle';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { RouteLink } from '@/components/ui/route-link';
import { ProductGrid } from '@/components/storefront/product-grid';
import { Footer } from '@/components/storefront/footer';

export function WishlistPage() {
  const { transition: onTransition } = useUi();
  const { wishlist, onToggleWishlist } = useWishlistToggle();
  const { clear } = useWishlist();
  // Wishlist ids live in this browser; product data (prices, names, stock) always comes from the API.
  const query = useQuery({
    queryKey: ['wishlist-products', [...wishlist].sort().join(',')],
    queryFn: ({ signal }) => api.catalog.listProducts({ ids: wishlist, pageSize: 100 }, signal),
    enabled: wishlist.length > 0,
    placeholderData: keepPreviousData,
  });
  const saved = wishlist.length ? (query.data?.items ?? []).filter(product => wishlist.includes(product.id)) : [];
  return <><main className="wishlist-page"><div className="wishlist-title"><div className="breadcrumbs"><RouteLink href="/" onClick={onTransition}>Home</RouteLink><span>/</span><span>Wishlist</span></div><span className="eyebrow">YOUR PERSONAL EDIT</span><h1>Saved for later<span>.</span></h1><p>A little shortlist of things you love. They're right here when you're ready.</p></div>{query.isError ? <div className="error-state" role="alert"><p>{errorMessage(query.error)}</p><button className="button button-dark" onClick={() => query.refetch()}>TRY AGAIN</button></div> : query.isLoading ? <div className="loading-state" role="status">Loading your saved pieces…</div> : saved.length ? <><div className="wishlist-toolbar"><span>{saved.length} {saved.length === 1 ? 'piece' : 'pieces'} saved</span><button className="text-link" onClick={() => clear()}>CLEAR WISHLIST <X size={14} /></button></div><ProductGrid products={saved} onToggleWishlist={onToggleWishlist} wishlist={wishlist} onTransition={onTransition} /></> : <div className="empty-wishlist"><div className="empty-heart"><Heart size={43} strokeWidth={1} /><Sparkles size={17} /></div><span className="eyebrow">GOOD TASTE, NO PRESSURE</span><h2>Keep the pieces you love close.</h2><p>Tap the heart on anything that catches your eye, and your personal edit will live here.</p><RouteLink href="/collections/all" className="button button-dark" onClick={onTransition}>DISCOVER YOUR NEXT FAVOURITE <ArrowRight size={16} /></RouteLink></div>}</main><Footer /></>;
}
