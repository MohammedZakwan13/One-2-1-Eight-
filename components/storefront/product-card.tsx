'use client';

import { ArrowUpRight, Heart, Star } from 'lucide-react';
import { effectiveStockMode, stockLine } from '@/lib/inventory';
import { SmartImage } from '@/components/ui/smart-image';
import { RouteLink } from '@/components/ui/route-link';
import { money } from '@/lib/format';
import type { Product } from '@/lib/api/schemas';
import { discountPercent } from '@/lib/catalog';

export function ProductCard({ product, isSaved, onToggleWishlist, onTransition }: { product: Product; isSaved: boolean; onToggleWishlist: (id: string, name?: string) => void; onTransition: () => void; }) {
  const discount = discountPercent(product);
  const href = `/products/${product.slug}`;
  return <article className="product-card">
    <div className="product-card-media"><RouteLink href={href} onClick={onTransition} className="product-image-link"><SmartImage src={product.images[0]} alt={product.name} /></RouteLink>
      {product.badge && <span className="product-badge">{product.badge}</span>}
      {discount > 0 && <span className="discount-badge">-{discount}%</span>}
      <button className={`wishlist-float ${isSaved ? 'is-saved' : ''}`} aria-label={isSaved ? 'Remove from wishlist' : 'Add to wishlist'} onClick={() => onToggleWishlist(product.id, product.name)}><Heart size={19} fill={isSaved ? 'currentColor' : 'none'} strokeWidth={1.65} /></button>
      <RouteLink href={href} className="quick-add" onClick={onTransition}>VIEW PRODUCT <ArrowUpRight size={15} /></RouteLink>
    </div>
    <div className="product-card-info"><div className="product-card-title-row"><RouteLink href={href} onClick={onTransition} className="product-card-name">{product.name}</RouteLink>{product.reviewCount > 0 && <span className="card-rating"><Star size={12} fill="currentColor" /> {product.rating.toFixed(1)}</span>}</div><div className="product-card-meta"><span>{product.color}</span><span>{product.variants.length} sizes</span></div><div className="product-price-row"><strong>{money(product.price)}</strong>{product.compareAt > product.price && <del>{money(product.compareAt)}</del>}</div>{effectiveStockMode(product) === 'custom' && stockLine('custom', product.stockMessage, undefined, product.stockMessageNumber) && <p className="product-card-stock-note"><span className="stock-note-tag">Note</span>{stockLine('custom', product.stockMessage, undefined, product.stockMessageNumber)}</p>}<div className="color-dot-row"><i style={{ background: product.colorHex }} /><span>+ curated colours</span></div></div>
  </article>;
}
