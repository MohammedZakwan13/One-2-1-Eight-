'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { TransitionProvider } from '@/components/providers/app-providers';
import { StorefrontDataProvider, type StorefrontData } from '@/components/providers/storefront-data';
import { MovingLoader } from '@/components/ui/moving-loader';
import { StoreHeader } from '@/components/storefront/header';
import { MobileBottomNav } from '@/components/storefront/mobile-bottom-nav';
import { SideMenu } from '@/components/storefront/side-menu';
import { SearchOverlay } from '@/components/storefront/search-overlay';
import { useCart } from '@/lib/hooks/use-cart';
import { useWishlist } from '@/lib/hooks/use-wishlist';

// The approved first-visit splash plays once per browser session of the SPA, never between in-app navigations.
let globalInitialSplashDone = false;

export function StorefrontShell({ data, children }: { data: StorefrontData; children: React.ReactNode }) {
  const path = usePathname() || '/';
  const { count: bagCount } = useCart();
  const { ids: wishlistIds } = useWishlist();
  const wishlistCount = wishlistIds.length;
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [splashVisible, setSplashVisible] = useState(!globalInitialSplashDone);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (globalInitialSplashDone) {
      if (splashVisible) setSplashVisible(false);
      return;
    }
    const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The splash video ends the splash itself (see finishSplash); this is only the safety net if it never plays or ends.
    const splashTimer = window.setTimeout(() => {
      setSplashVisible(false);
      globalInitialSplashDone = true;
    }, isReduced ? 1200 : 10000);
    return () => window.clearTimeout(splashTimer);
  }, [splashVisible]);

  const finishSplash = useCallback(() => { globalInitialSplashDone = true; setSplashVisible(false); }, []);

  const transition = useCallback(() => {
    setTransitioning(true);
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
    transitionTimer.current = setTimeout(() => setTransitioning(false), 230);
  }, []);

  const lastPath = useRef(path);
  useEffect(() => {
    setMenuOpen(false); setSearchOpen(false);
    if (lastPath.current !== path) {
      setTransitioning(true);
      if (transitionTimer.current) clearTimeout(transitionTimer.current);
      transitionTimer.current = setTimeout(() => setTransitioning(false), 230);
    }
    lastPath.current = path;
  }, [path]);
  useEffect(() => () => { if (transitionTimer.current) clearTimeout(transitionTimer.current); }, []);

  // Escape closes the menu / search overlays (keyboard accessibility).
  useEffect(() => {
    if (!menuOpen && !searchOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); setSearchOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, searchOpen]);

  useEffect(() => {
    if (splashVisible) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const isLuxePage = path === '/collections/one-2-1-eight-luxe';
    const targets = Array.from(document.querySelectorAll<HTMLElement>(
      '.home-main > section:not(.hero-section), .collection-masthead, .collection-toolbar, .collection-products .product-card, .collection-endnote, .product-layout, .reviews-section, .related-products-section, .bag-page > *, .wishlist-page > *, .search-page > *'
    ));
    if (!targets.length) return;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('scroll-reveal-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -46px 0px' });
    targets.forEach((element, index) => {
      element.classList.add('scroll-reveal-pending');
      if (element.classList.contains('product-card')) element.style.setProperty('--reveal-delay', `${Math.min(index % 4, 3) * (isLuxePage ? 115 : 65)}ms`);
      observer.observe(element);
    });
    return () => { observer.disconnect(); targets.forEach(element => { element.classList.remove('scroll-reveal-pending', 'scroll-reveal-visible'); element.style.removeProperty('--reveal-delay'); }); };
  }, [path, splashVisible]);

  return (
    <StorefrontDataProvider value={data}>
      <TransitionProvider transition={transition}>
        <div className="storefront-app">
          <StoreHeader onSearch={() => setSearchOpen(true)} onMenu={() => setMenuOpen(true)} onTransition={transition} cartCount={bagCount} wishlistCount={wishlistCount} settings={data.settings} />
          <div key={path} className={`route-screen ${path === '/collections/one-2-1-eight-luxe' ? 'route-screen-luxe' : ''}`}>{children}</div>
          <MobileBottomNav onTransition={transition} cartCount={bagCount} wishlistCount={wishlistCount} />
          <SideMenu open={menuOpen} close={() => setMenuOpen(false)} categories={data.categories} onTransition={transition} />
          <SearchOverlay open={searchOpen} close={() => setSearchOpen(false)} onTransition={transition} />
          {transitioning && !splashVisible && <MovingLoader />}
          {splashVisible && <MovingLoader initial onDone={finishSplash} />}
        </div>
      </TransitionProvider>
    </StorefrontDataProvider>
  );
}
