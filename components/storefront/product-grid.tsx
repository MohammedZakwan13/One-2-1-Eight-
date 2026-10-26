'use client';

import { ArrowRight, Sparkles } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { ProductCard } from '@/components/storefront/product-card';
import type { Product } from '@/lib/api/schemas';

export function ProductGrid({ products, onToggleWishlist, wishlist, onTransition, emptyTitle = 'Nothing here just yet' }: { products: Product[]; onToggleWishlist: (id: string, name?: string) => void; wishlist: string[]; onTransition: () => void; emptyTitle?: string }) {
  if (!products.length) return <div className="empty-products"><Sparkles size={25} /><h3>{emptyTitle}</h3><p>Try another category or clear your filters.</p><RouteLink href="/collections/all" onClick={onTransition} className="button button-dark">EXPLORE ALL PIECES <ArrowRight size={15} /></RouteLink></div>;
  return <div className="product-grid">{products.map(product => <ProductCard key={product.id} product={product} isSaved={wishlist.includes(product.id)} onToggleWishlist={onToggleWishlist} onTransition={onTransition} />)}</div>;
}
