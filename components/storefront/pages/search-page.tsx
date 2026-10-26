'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useUi } from '@/components/providers/app-providers';
import { useStorefrontData } from '@/components/providers/storefront-data';
import { useWishlistToggle } from '@/lib/hooks/use-wishlist-toggle';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { isStorefrontCategory } from '@/lib/catalog';
import { ArrowUpRight, Search, X } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { ProductGrid } from '@/components/storefront/product-grid';
import { Footer } from '@/components/storefront/footer';

export function SearchPage({ initialQuery }: { initialQuery: string }) {
  const { categories } = useStorefrontData();
  const { transition: onTransition } = useUi();
  const { wishlist, onToggleWishlist } = useWishlistToggle();
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  useEffect(() => { const id = window.setTimeout(() => setDebounced(query.trim()), 250); return () => window.clearTimeout(id); }, [query]);
  // Keep the address bar shareable (?q=…) without a navigation.
  useEffect(() => { window.history.replaceState(null, '', debounced ? `/search?q=${encodeURIComponent(debounced)}` : '/search'); }, [debounced]);
  const search = useQuery({ queryKey: ['search', debounced], queryFn: ({ signal }) => api.catalog.listProducts({ q: debounced || undefined, pageSize: 48 }, signal), placeholderData: keepPreviousData });
  const items = search.data?.items ?? [];
  const resultCount = search.data?.total ?? 0;
  return <><main className="search-page"><div className="search-page-head"><span className="eyebrow">A BETTER WAY TO FIND YOUR FIT</span><h1>Discover your style<span>.</span></h1><div className="search-page-input"><Search size={22} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Try ‘box fit tee’ or ‘luxe polo’" aria-label="Search all products" /><button onClick={() => setQuery('')} aria-label="Clear search"><X size={18} /></button></div><div className="search-trending-label">{query ? `${resultCount} RESULTS FOR “${query.toUpperCase()}”` : 'POPULAR CATEGORIES'}</div>{!query && <div className="search-category-chips">{categories.filter(isStorefrontCategory).map(cat => <RouteLink href={`/collections/${cat.slug}`} key={cat.id} onClick={onTransition}>{cat.name} <ArrowUpRight size={13} /></RouteLink>)}</div>}</div>{search.isError && <div className="error-state" role="alert"><p>{errorMessage(search.error)}</p><button className="button button-dark" onClick={() => search.refetch()}>TRY AGAIN</button></div>}<section className="search-results"><div className="search-results-heading"><h2>{query ? 'Search results' : 'Currently in rotation'}</h2><span>{resultCount} pieces</span></div><ProductGrid products={items} onToggleWishlist={onToggleWishlist} wishlist={wishlist} onTransition={onTransition} emptyTitle="No matching pieces found" /></section></main><Footer /></>;
}
