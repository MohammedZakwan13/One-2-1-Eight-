'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { SmartImage } from '@/components/ui/smart-image';
import type { Product } from '@/lib/api/schemas';

/** The existing LUXE collection page. Every card in this rail leads here (not to the product page). */
const LUXE_HREF = '/collections/one-2-1-eight-luxe';

/**
 * Headerless, image-and-name-only single-row LUXE rail shown between the hero and "Shop by category". The products are exactly what the backend returns for the
 * existing LUXE collection (active products with the luxe flag); nothing is hard-coded and an empty result renders nothing.
 * Only the track scrolls horizontally: native touch/swipe with snapping, plus previous/next buttons on larger screens.
 */
export function LuxeRail({ products, onTransition }: { products: Product[]; onTransition: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    measure();
    const el = track.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, products.length]);

  if (!products.length) return null;
  const scrollBy = (direction: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: direction * Math.max(240, el.clientWidth * 0.8), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  return <section className="luxe-rail-section section-shell" aria-label="ONE 2 1 EIGHT LUXE">
    <div className={`luxe-rail ${edge.end ? '' : 'has-more'}`}>
      {!(edge.start && edge.end) && <button type="button" className="luxe-rail-btn luxe-rail-prev" aria-label="Previous LUXE products" disabled={edge.start} onClick={() => scrollBy(-1)}><ChevronLeft size={20} /></button>}
      <div className="luxe-rail-track" ref={track} onScroll={measure} role="region" aria-label="LUXE products, scroll horizontally" tabIndex={0}>
        {products.map(product => <div className="luxe-rail-item" key={product.id}><RouteLink href={LUXE_HREF} className="luxe-tile" onClick={onTransition}><span className="luxe-tile-name">{product.name}</span><SmartImage src={product.images[0]} alt={product.name} /></RouteLink></div>)}
      </div>
      {!(edge.start && edge.end) && <button type="button" className="luxe-rail-btn luxe-rail-next" aria-label="Next LUXE products" disabled={edge.end} onClick={() => scrollBy(1)}><ChevronRight size={20} /></button>}
    </div>
  </section>;
}
