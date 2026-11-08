'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { HeroSlide } from '@/lib/api/schemas';
import { createSlideScheduler, hasVideoSlides, slideKind, startImageRotation, type HeroEnvironment, type SlideScheduler } from '@/lib/hero-timing';
import { INITIAL_PAUSE, focusEntersCarousel, isRotationPaused, pointerPausesRotation, reducePause } from '@/lib/hero-pause';
import { arrowKeyStep, classifySwipe, wrapIndex } from '@/lib/hero-nav';

/** `null` until the browser has been asked (server render and first client render), so nothing device-specific happens early. */
function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** The one place that decides "phone or not" and "reduced motion", shared by the timing and the media so they can never disagree. */
export function useHeroEnvironment(): HeroEnvironment {
  const isMobile = useMediaQuery('(max-width: 600px)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  return useMemo(() => ({ isMobile, reducedMotion }), [isMobile, reducedMotion]);
}

export type VideoPlayback = {
  onSourceChange: () => void;
  onMetadata: (durationSeconds: number) => void;
  onPlaying: () => void;
  onEnded: () => void;
  onFailed: () => void;
};

/**
 * Automatic hero rotation plus manual navigation.
 *   - Banners that are all images: the ORIGINAL single 5.4 s interval (lib/hero-timing.ts `startImageRotation`).
 *   - Any video banner: the slide scheduler, which times each slide from the slide kind and the real video events.
 * Pausing (lib/hero-pause.ts): the Pause / Play button, keyboard focus entering the carousel (sticky, only Play resumes), and a mouse hovering
 * over it (temporary). Pausing only stops and re-arms the existing timers; it never changes the timing rules.
 * Manual navigation (arrows, indicators, swipe, arrow keys) just changes the current slide. That alone is what the timing already reacts to:
 * the scheduler re-activates for the new slide (cancelling the previous slide's timers) and the previous slide's video is unmounted, which
 * pauses it and releases its download. The image-only interval is restarted so the new slide gets its full 5.4 s, never the remainder.
 */
export function useHeroCarousel(slides: HeroSlide[], env: HeroEnvironment) {
  const count = slides.length;
  const [index, setIndex] = useState(0);
  /** Bumped by every MANUAL change of slide (never by the automatic rotation). */
  const [manualChanges, setManualChanges] = useState(0);
  const [pause, dispatchPause] = useReducer(reducePause, INITIAL_PAUSE);
  const [tabHidden, setTabHidden] = useState(false);
  const videoAware = useMemo(() => hasVideoSlides(slides), [slides]);
  const next = useCallback(() => setIndex(current => (current + 1) % count), [count]);
  const schedulerRef = useRef<SlideScheduler | null>(null);
  const swipe = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
  const swallowClick = useRef(false);

  useEffect(() => { if (index >= count) setIndex(0); }, [index, count]);

  // Original path (image-only): one interval; pausing simply stops it, resuming starts it again at the same 5.4 s.
  // `manualChanges` restarts it after a manual change so the slide the visitor chose is shown for its full time.
  const paused = isRotationPaused(pause);
  useEffect(() => {
    if (videoAware || paused) return;
    return startImageRotation(count, next);
  }, [videoAware, paused, count, next, manualChanges]);

  // Video-aware path.
  useEffect(() => {
    if (!videoAware || count < 2) return;
    const scheduler = createSlideScheduler(next);
    schedulerRef.current = scheduler;
    return () => { scheduler.dispose(); schedulerRef.current = null; };
  }, [videoAware, count, next]);

  const slide = slides[index];
  const kind = slide ? slideKind(slide, env) : 'image';
  const slideId = slide?.id;
  useEffect(() => { schedulerRef.current?.activate(kind); }, [videoAware, count, index, slideId, kind]);

  useEffect(() => {
    if (!videoAware) return;
    const update = () => setTabHidden(document.hidden);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [videoAware]);

  const autoPaused = paused || (videoAware && tabHidden);
  useEffect(() => { schedulerRef.current?.setPaused(autoPaused); }, [autoPaused, videoAware, count, index, slideId, kind]);

  const playback = useMemo<VideoPlayback>(() => ({
    onSourceChange: () => schedulerRef.current?.videoSourceChanged(),
    onMetadata: seconds => schedulerRef.current?.videoMetadata(seconds),
    onPlaying: () => schedulerRef.current?.videoPlaying(),
    onEnded: () => schedulerRef.current?.videoEnded(),
    onFailed: () => schedulerRef.current?.videoFailed(),
  }), []);

  /** Go to a banner. Choosing the banner already on screen does nothing (so it cannot restart anything). */
  const goTo = useCallback((target: number) => {
    if (count < 2) return;
    const to = wrapIndex(target, count);
    if (to === index) return;
    setIndex(to);
    setManualChanges(value => value + 1);
  }, [count, index]);
  const step = useCallback((delta: number) => goTo(index + delta), [goTo, index]);

  /** True once after a swipe, so the click that some browsers fire at the end of the gesture does not open the banner's link. */
  const consumeSwipeClick = useCallback(() => { const swallowed = swallowClick.current; swallowClick.current = false; return swallowed; }, []);

  /** Handlers for the carousel's container. Focus leaving does nothing on purpose: only the Play control resumes a focus pause. */
  const interactionProps = {
    onFocusCapture: (event: FocusEvent<HTMLElement>) => {
      if (!focusEntersCarousel(event.relatedTarget, event.currentTarget)) return; // moving between the controls inside is not "entering"
      let keyboard = true; // if :focus-visible is unsupported, pausing is the safe assumption
      try { keyboard = (event.target as HTMLElement).matches(':focus-visible'); } catch { keyboard = true; }
      if (keyboard) dispatchPause('keyboard-focus-enter');
    },
    onPointerEnter: (event: PointerEvent<HTMLElement>) => { if (pointerPausesRotation(event.pointerType)) dispatchPause('pointer-enter'); },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => { if (pointerPausesRotation(event.pointerType)) dispatchPause('pointer-leave'); },
    // Swipe (finger or pen). The container has `touch-action: pan-y`, so vertical scrolling stays with the browser and never reaches here as a swipe.
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      swallowClick.current = false;
      if (event.pointerType === 'mouse' || (event.target as HTMLElement).closest('button')) { swipe.current = null; return; }
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const start = swipe.current;
      swipe.current = null;
      if (!start || start.id !== event.pointerId) return;
      const direction = classifySwipe({ dx: event.clientX - start.x, dy: event.clientY - start.y, ms: event.timeStamp - start.at });
      if (!direction) return;
      swallowClick.current = true;
      goTo(index + (direction === 'next' ? 1 : -1));
    },
    onPointerCancel: () => { swipe.current = null; }, // the browser took the gesture over (a vertical scroll)
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const delta = arrowKeyStep(event.key);
      if (!delta || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      goTo(index + delta);
    },
  };

  return { index, slide, kind, count, manualChanges, userPaused: pause.user, togglePaused: () => dispatchPause('toggle'), paused: autoPaused, playback, interactionProps, goTo, step, consumeSwipeClick };
}
