'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { RouteLink } from '@/components/ui/route-link';
import { SmartImage } from '@/components/ui/smart-image';
import type { Product } from '@/lib/api/schemas';

/** The canonical LUXE collection page. Every card in this rail leads here. */
const LUXE_HREF = '/collections/one-2-1-eight-luxe';

/**
 * Headerless, image-and-name-only category rail shown between the hero and "Shop by category".
 * - Desktop: smooth auto-advancing horizontal rail with click-and-drag, mouse-wheel, keyboard, and prev/next controls.
 * - Mobile: 3-column Snitch-style category grid with subtle light-grey dividers, normal vertical scroll.
 */
export function LuxeRail({ products, onTransition }: { products: Product[]; onTransition: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const [isMobile, setIsMobile] = useState(false);

  // Interaction refs for auto-advance control
  const isHovered = useRef(false);
  const isFocused = useRef(false);
  const isDragging = useRef(false);
  const dragMoved = useRef(false);
  const startX = useRef(0);
  const startScrollLeft = useRef(0);
  const interactionTimer = useRef<NodeJS.Timeout | null>(null);

  // Check mobile viewport
  useEffect(() => {
    const updateMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    updateMobile();
    window.addEventListener('resize', updateMobile, { passive: true });
    return () => window.removeEventListener('resize', updateMobile);
  }, []);

  const measure = useCallback(() => {
    const el = track.current;
    if (!el || isMobile) return;
    const atStart = el.scrollLeft <= 4;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 6;
    setEdge({ start: atStart, end: atEnd });
  }, [isMobile]);

  useEffect(() => {
    measure();
    const el = track.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, products.length, isMobile]);

  const pauseInteraction = useCallback(() => {
    if (interactionTimer.current) clearTimeout(interactionTimer.current);
  }, []);

  const resumeInteractionAfterDelay = useCallback(() => {
    if (interactionTimer.current) clearTimeout(interactionTimer.current);
    interactionTimer.current = setTimeout(() => {
      // interaction cleared
    }, 3000);
  }, []);

  // Desktop smooth auto-advance
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion || isMobile) return;

    const interval = setInterval(() => {
      if (isMobile || isHovered.current || isFocused.current || isDragging.current) return;
      const el = track.current;
      if (!el) return;

      const firstItem = el.querySelector<HTMLElement>('.luxe-rail-item');
      const itemWidth = firstItem ? firstItem.offsetWidth : 200;
      const gap = 32;
      const step = itemWidth + gap;

      // When near the end, smoothly wrap back to start
      if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 10) {
        el.scrollTo({ left: 0, behavior: 'smooth' });
      } else {
        el.scrollBy({ left: step, behavior: 'smooth' });
      }
    }, 3600);

    return () => clearInterval(interval);
  }, [isMobile]);

  if (!products.length) return null;

  const scrollByDirection = (direction: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    pauseInteraction();
    const firstItem = el.querySelector<HTMLElement>('.luxe-rail-item');
    const itemWidth = firstItem ? firstItem.offsetWidth : 200;
    const gap = 32;
    const step = (itemWidth + gap) * (direction === 1 ? 1 : -1);
    el.scrollBy({
      left: step,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    resumeInteractionAfterDelay();
  };

  // Click & drag handling for desktop
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = track.current;
    if (!el) return;
    isDragging.current = true;
    dragMoved.current = false;
    startX.current = e.pageX - el.offsetLeft;
    startScrollLeft.current = el.scrollLeft;
    pauseInteraction();
    el.style.scrollSnapType = 'none';
    el.style.cursor = 'grabbing';
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current || isMobile) return;
    const el = track.current;
    if (!el) return;
    const currentX = e.pageX - el.offsetLeft;
    const delta = currentX - startX.current;
    if (Math.abs(delta) > 5) {
      dragMoved.current = true;
    }
    el.scrollLeft = startScrollLeft.current - delta;
  };

  const handlePointerUp = () => {
    if (!isDragging.current || isMobile) return;
    isDragging.current = false;
    const el = track.current;
    if (el) {
      el.style.scrollSnapType = '';
      el.style.cursor = '';
    }
    resumeInteractionAfterDelay();
    setTimeout(() => {
      dragMoved.current = false;
    }, 60);
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      scrollByDirection(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      scrollByDirection(1);
    }
  };

  // On desktop, repeat items when needed so continuous scrolling has sufficient items
  const displayProducts = isMobile
    ? products
    : products.length < 8
      ? [...products, ...products, ...products]
      : products;

  return (
    <section className="luxe-rail-section section-shell" aria-label="ONE 2 1 EIGHT LUXE">
      <div className={`luxe-rail ${edge.end ? '' : 'has-more'}`}>
        {!isMobile && (
          <button
            type="button"
            className="luxe-rail-btn luxe-rail-prev"
            aria-label="Previous LUXE products"
            disabled={edge.start}
            onClick={() => scrollByDirection(-1)}
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <div
          className="luxe-rail-track"
          ref={track}
          onScroll={measure}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onMouseEnter={() => {
            isHovered.current = true;
            pauseInteraction();
          }}
          onMouseLeave={() => {
            isHovered.current = false;
            handlePointerUp();
            resumeInteractionAfterDelay();
          }}
          onFocus={() => {
            isFocused.current = true;
            pauseInteraction();
          }}
          onBlur={() => {
            isFocused.current = false;
            resumeInteractionAfterDelay();
          }}
          onKeyDown={handleKeyDown}
          role="region"
          aria-label="LUXE products"
          tabIndex={isMobile ? -1 : 0}
        >
          {displayProducts.map((product, idx) => (
            <div
              className="luxe-rail-item"
              key={`${product.id}-${idx}`}
              onClickCapture={(e) => {
                if (dragMoved.current) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            >
              <RouteLink
                href={LUXE_HREF}
                className="luxe-tile"
                onClick={onTransition}
              >
                <span className="luxe-tile-name">{product.name}</span>
                <SmartImage src={product.images[0] ?? ''} alt={product.name} />
              </RouteLink>
            </div>
          ))}
        </div>
        {!isMobile && (
          <button
            type="button"
            className="luxe-rail-btn luxe-rail-next"
            aria-label="Next LUXE products"
            disabled={edge.end}
            onClick={() => scrollByDirection(1)}
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>
    </section>
  );
}
