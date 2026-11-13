'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { HeroMedia } from '@/components/storefront/hero-media';
import { useUi } from '@/components/providers/app-providers';
import type { HeroSlide } from '@/lib/api/schemas';
import { useHeroCarousel, useHeroEnvironment } from '@/lib/hooks/use-hero-carousel';
import { formatCounter, indicatorMax, indicatorWindow } from '@/lib/hero-nav';

/**
 * The homepage hero: the banner, automatic rotation (timing in lib/hero-timing.ts), previous / next arrows, slide indicators with a small
 * pause / play icon beside them (automatic movement must stay stoppable: WCAG 2.2.2), and swipe. The page order is the keyboard order:
 * pause / play first, then the indicators, the arrows and finally the banner link. CSS places them visually; they sit OUTSIDE the banner
 * link so pressing one never opens the banner.
 */
export function HeroCarousel({ slides, brandLine }: { slides: HeroSlide[]; brandLine: string }) {
  const { transition: onTransition } = useUi();
  const env = useHeroEnvironment();
  const { index, slide, count, manualChanges, userPaused, togglePaused, paused, playback, interactionProps, goTo, step, consumeSwipeClick } = useHeroCarousel(slides, env);
  const several = count > 1;
  const { start, end } = indicatorWindow(count, index, indicatorMax(env.isMobile));

  // Screen-reader announcement, only after a change the visitor made (the automatic rotation stays silent).
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (manualChanges === 0 || !slide) return;
    setAnnouncement(`Banner ${index + 1} of ${count}: ${slide.title.replace(/\n/g, ' ')}`);
  }, [manualChanges, index, count, slide]);

  return <section className="hero-section" aria-label="Featured campaign" aria-roledescription="carousel" {...interactionProps}>
    {/* The navigation bar comes first in the page order, so the pause / play icon is the first keyboard stop in the carousel; CSS places it. */}
    {several && <div className="hero-nav-bar">
      <button type="button" className="hero-pause" onClick={togglePaused} aria-pressed={userPaused} aria-label={userPaused ? 'Play automatic slideshow' : 'Pause automatic slideshow'} title={userPaused ? 'Play automatic slideshow' : 'Pause automatic slideshow'}>{userPaused ? <Play size={11} aria-hidden="true" /> : <Pause size={11} aria-hidden="true" />}</button>
      <div className="hero-indicators" role="group" aria-label="Choose banner">
        {Array.from({ length: end - start }, (_, offset) => start + offset).map(position => <button key={position} type="button" className={`hero-dot ${position === index ? 'is-active' : ''}`} onClick={() => goTo(position)} aria-label={`Go to banner ${position + 1} of ${count}`} aria-current={position === index ? 'true' : undefined}><span /></button>)}
        {count > end - start && <span className="hero-counter" aria-hidden="true">{formatCounter(index, count)}</span>}
      </div>
    </div>}
    {several && <button type="button" className="hero-arrow hero-arrow-prev" onClick={() => step(-1)} aria-label="Previous banner"><ChevronLeft size={18} aria-hidden="true" /></button>}
    {several && <button type="button" className="hero-arrow hero-arrow-next" onClick={() => step(1)} aria-label="Next banner"><ChevronRight size={18} aria-hidden="true" /></button>}
    {slide ? <Link href={slide.href} className="hero-slide hero-slide-link" key={slide.id} onClick={event => { if (consumeSwipeClick()) { event.preventDefault(); return; } onTransition(); }} aria-label="Shop all ONE 2 1 EIGHT menswear">
      <HeroMedia slide={slide} priority={index === 0} env={env} paused={paused} playback={playback} single={!several} />
      <div className="hero-gradient" />
      <div className="hero-content"><h1>{slide.title.split('\n').map((line, idx) => <React.Fragment key={`${line}-${idx}`}>{line}{idx === 0 && slide.title.includes('\n') && <br />}</React.Fragment>)}</h1><p>{slide.body}</p></div>
    </Link> : <div className="hero-empty"><BrandMark /><h1>{brandLine}</h1></div>}
    <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
  </section>;
}
