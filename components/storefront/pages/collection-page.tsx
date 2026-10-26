'use client';

import { useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { ProductGrid } from '@/components/storefront/product-grid';
import { Footer } from '@/components/storefront/footer';
import { money } from '@/lib/format';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useWishlistToggle } from '@/lib/hooks/use-wishlist-toggle';
import type { Product } from '@/lib/api/schemas';
import { imageSizes, isStorefrontCategory, productSizes } from '@/lib/catalog';

/** `products` is the server-fetched set for this collection/category; sorting and refinement below run client-side over it. */
export function CollectionPage({ slug, title, products }: { slug: string; title: string; products: Product[] }) {
  const { categories } = useStorefrontData();
  const { transition: onTransition } = useUi();
  const { wishlist, onToggleWishlist } = useWishlistToggle();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [maxPriceChoice, setMaxPrice] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState('featured');
  const [search, setSearch] = useState('');
  const base = products;
  const priceCeiling = Math.max(3000, Math.ceil(Math.max(0, ...base.map(product => product.price)) / 100) * 100);
  const maxPrice = maxPriceChoice ?? priceCeiling;
  const colors = Array.from(new Set(base.map(p => p.color)));
  const filtered = base.filter(product => product.price <= maxPrice && (!selectedSizes.length || selectedSizes.some(size => productSizes(product).includes(size))) && (!selectedColors.length || selectedColors.includes(product.color)) && (!search || `${product.name} ${product.category} ${product.color}`.toLowerCase().includes(search.toLowerCase())));
  const sorted = [...filtered].sort((a, b) => sortBy === 'price-low' ? a.price - b.price : sortBy === 'price-high' ? b.price - a.price : sortBy === 'rating' ? b.rating - a.rating : sortBy === 'new' ? Number(b.newArrival) - Number(a.newArrival) : Number(b.bestSeller) - Number(a.bestSeller));
  const clearFilters = () => { setSelectedSizes([]); setSelectedColors([]); setMaxPrice(null); setSearch(''); setSortBy('featured'); };
  const collectionDescription = slug === 'one-2-1-eight-luxe' ? 'A more considered wardrobe: elevated textures, refined details and quieter statements.' : slug === 'new-arrivals' ? 'The latest fits and fresh colour stories, selected for the season ahead.' : slug === 'best-sellers' ? 'The pieces customers come back for. Proven favourites, ready for your rotation.' : 'Find your next everyday favourite in our considered collection of modern essentials.';
  return <><main className={`collection-page ${slug === 'one-2-1-eight-luxe' ? 'collection-page-luxe' : ''}`}>
    <div className={`collection-masthead ${slug === 'one-2-1-eight-luxe' ? 'collection-masthead-luxe' : ''}`}><div className="breadcrumbs"><RouteLink href="/" onClick={onTransition}>Home</RouteLink><span>/</span><span>{title}</span></div><div className="collection-title-row"><div><span className="eyebrow">THE 1218 COLLECTION / {String(base.length).padStart(2, '0')} PIECES</span><h1>{title}</h1><p>{collectionDescription}</p></div>{slug === 'one-2-1-eight-luxe' && <div className="luxe-stamp"><Sparkles size={22} /><span>CURATED<br />EXCLUSIVES</span></div>}</div>
      {slug !== 'one-2-1-eight-luxe' && <div className="collection-category-chips"><RouteLink href="/collections/all" onClick={onTransition}>ALL PIECES</RouteLink>{categories.filter(isStorefrontCategory).map(category => <RouteLink href={`/collections/${category.slug}`} key={category.id} className={category.slug === slug ? 'active' : ''} onClick={onTransition}>{category.name.toUpperCase()}</RouteLink>)}</div>}
    </div>
    <div className="collection-toolbar"><span>{sorted.length} pieces to discover</span><div className="collection-toolbar-actions"><label className="collection-search"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search this edit" aria-label="Search this collection" /></label><label className="sort-select"><span>SORT BY</span><select value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort products"><option value="featured">Featured</option><option value="new">Newest</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="rating">Top rated</option></select><ChevronDown size={15} /></label><button className={`filter-button ${filtersOpen ? 'is-active' : ''}`} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={16} /> FILTERS <span>{selectedSizes.length + selectedColors.length + (maxPrice < priceCeiling ? 1 : 0) || ''}</span></button></div></div>
    {filtersOpen && <div className="filter-panel"><div className="filter-panel-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h3>Filter & refine</h3></div><button className="icon-button" onClick={() => setFiltersOpen(false)} aria-label="Close filters"><X /></button></div><div className="filter-groups"><div className="filter-group"><h4>SIZE</h4><div className="filter-size-options">{imageSizes.map(size => <button key={size} className={selectedSizes.includes(size) ? 'selected' : ''} onClick={() => setSelectedSizes(current => current.includes(size) ? current.filter(item => item !== size) : [...current, size])}>{size}</button>)}</div></div><div className="filter-group"><h4>COLOUR</h4><div className="filter-color-options">{colors.map(color => { const product = base.find(item => item.color === color); return <button key={color} className={selectedColors.includes(color) ? 'selected' : ''} onClick={() => setSelectedColors(current => current.includes(color) ? current.filter(item => item !== color) : [...current, color])}><i style={{ background: product?.colorHex }} />{color}</button>; })}</div></div><div className="filter-group price-filter-group"><h4>PRICE UP TO <strong>{money(maxPrice)}</strong></h4><input type="range" min="500" max={priceCeiling} step="100" value={maxPrice} onChange={e => setMaxPrice(Number(e.target.value))} aria-label="Maximum price" /><div className="range-labels"><span>₹500</span><span>{money(priceCeiling)}+</span></div></div></div><div className="filter-footer"><button className="text-link" onClick={clearFilters}>CLEAR ALL</button><button className="button button-dark" onClick={() => setFiltersOpen(false)}>SHOW {sorted.length} PIECES <ArrowRight size={15} /></button></div></div>}
    <section className="collection-products"><ProductGrid products={sorted} onToggleWishlist={onToggleWishlist} wishlist={wishlist} onTransition={onTransition} emptyTitle="No pieces match just yet" /></section>
    <div className="collection-endnote"><span className="eyebrow">GOOD THINGS TAKE YOU PLACES</span><p>Explore a little further. Your next favourite might be one click away.</p><RouteLink href="/collections/all" onClick={onTransition} className="text-link">DISCOVER ALL PIECES <ArrowUpRight size={16} /></RouteLink></div>
  </main><Footer /></>;
}
