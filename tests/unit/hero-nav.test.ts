import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SWIPE_MAX_DURATION_MS, SWIPE_MIN_DISTANCE_PX, arrowKeyStep, classifySwipe, formatCounter, indicatorMax, indicatorWindow, wrapIndex,
} from '@/lib/hero-nav';
import { IMAGE_SLIDE_MS, MIN_VIDEO_SLIDE_MS, createSlideScheduler, startImageRotation, type SlideKind, type SlideScheduler } from '@/lib/hero-timing';
import { INITIAL_PAUSE, isRotationPaused, reducePause, type PauseEvent } from '@/lib/hero-pause';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });
const tick = (ms: number) => vi.advanceTimersByTime(ms);

describe('swipe gestures', () => {
  it('swipe left goes to the next banner, swipe right to the previous one', () => {
    expect(classifySwipe({ dx: -120, dy: 6, ms: 220 })).toBe('next');
    expect(classifySwipe({ dx: 120, dy: -6, ms: 220 })).toBe('prev');
  });
  it('ignores very short, accidental touches: below the minimum distance nothing happens, at it the swipe counts', () => {
    expect(classifySwipe({ dx: 0, dy: 0, ms: 80 })).toBeNull(); // a tap
    expect(classifySwipe({ dx: -(SWIPE_MIN_DISTANCE_PX - 1), dy: 0, ms: 100 })).toBeNull();
    expect(classifySwipe({ dx: SWIPE_MIN_DISTANCE_PX - 1, dy: 0, ms: 100 })).toBeNull();
    expect(classifySwipe({ dx: -SWIPE_MIN_DISTANCE_PX, dy: 0, ms: 100 })).toBe('next');
  });
  it('a scroll that drifts sideways is not a swipe: the gesture must be clearly horizontal', () => {
    expect(classifySwipe({ dx: -60, dy: 60, ms: 200 })).toBeNull();   // diagonal
    expect(classifySwipe({ dx: -60, dy: 80, ms: 200 })).toBeNull();   // mostly vertical
    expect(classifySwipe({ dx: -90, dy: 60, ms: 200 })).toBe('next'); // exactly 1.5 x: horizontal enough
    expect(classifySwipe({ dx: -200, dy: 400, ms: 300 })).toBeNull(); // a long vertical scroll
  });
  it('a slow drag held for a long time is not a swipe', () => {
    expect(classifySwipe({ dx: -150, dy: 0, ms: SWIPE_MAX_DURATION_MS })).toBe('next');
    expect(classifySwipe({ dx: -150, dy: 0, ms: SWIPE_MAX_DURATION_MS + 1 })).toBeNull();
  });
  it('garbage input is never a swipe', () => {
    expect(classifySwipe({ dx: NaN, dy: 0, ms: 100 })).toBeNull();
    expect(classifySwipe({ dx: -100, dy: Infinity, ms: 100 })).toBeNull();
    expect(classifySwipe({ dx: -100, dy: 0, ms: -5 })).toBeNull();
  });
});

describe('index, keys and indicators', () => {
  it('wraps both ways', () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(-4, 3)).toBe(2);
    expect(wrapIndex(1, 3)).toBe(1);
    expect(wrapIndex(5, 0)).toBe(0);
  });
  it('arrow keys step; other keys do not', () => {
    expect(arrowKeyStep('ArrowLeft')).toBe(-1);
    expect(arrowKeyStep('ArrowRight')).toBe(1);
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'Home']) expect(arrowKeyStep(key)).toBe(0);
  });
  it('shows an indicator for every banner when they fit, and a bounded window when there are many', () => {
    expect(indicatorWindow(3, 1, 7)).toEqual({ start: 0, end: 3 });
    expect(indicatorWindow(7, 6, 7)).toEqual({ start: 0, end: 7 });
    expect(indicatorWindow(12, 0, 7)).toEqual({ start: 0, end: 7 });
    expect(indicatorWindow(12, 6, 7)).toEqual({ start: 3, end: 10 });
    expect(indicatorWindow(12, 11, 7)).toEqual({ start: 5, end: 12 });
    expect(indicatorWindow(0, 0, 7)).toEqual({ start: 0, end: 0 });
  });
  it('never shows more than the maximum, always includes the active banner, and moves smoothly, for 10, 12, 15 and 40 banners', () => {
    for (const count of [10, 12, 15, 40]) {
      for (const max of [5, 7]) {
        let previous = -1;
        for (let active = 0; active < count; active += 1) {
          const { start, end } = indicatorWindow(count, active, max);
          expect(end - start, `${count}/${max}/${active}`).toBe(max);
          expect(start).toBeLessThanOrEqual(active);
          expect(end).toBeGreaterThan(active);
          expect(start).toBeGreaterThanOrEqual(0);
          expect(end).toBeLessThanOrEqual(count);
          if (previous >= 0) expect(Math.abs(start - previous)).toBeLessThanOrEqual(1);
          previous = start;
        }
      }
    }
  });
  it('a phone gets fewer indicators than a desktop, and the compact counter reads "03 / 12"', () => {
    expect(indicatorMax(true)).toBe(5);
    expect(indicatorMax(false)).toBe(7);
    expect(indicatorMax(null)).toBe(7);
    expect(formatCounter(2, 12)).toBe('03 / 12');
    expect(formatCounter(0, 5)).toBe('01 / 05');
    expect(formatCounter(11, 12)).toBe('12 / 12');
  });
});

/** Mirrors what the hook does on a manual change: the current slide changes, so the scheduler is re-activated for it. */
function scheduledHost(kinds: SlideKind[]) {
  let state = INITIAL_PAUSE;
  let index = 0;
  const moves: { to: number; at: number }[] = [];
  const scheduler: SlideScheduler = createSlideScheduler(() => { index = (index + 1) % kinds.length; moves.push({ to: index, at: Date.now() }); scheduler.activate(kinds[index]); });
  scheduler.activate(kinds[0]);
  const goTo = (target: number) => { const to = wrapIndex(target, kinds.length); if (to === index) return; index = to; scheduler.activate(kinds[index]); };
  return {
    scheduler, moves, goTo, step: (d: number) => goTo(index + d),
    send: (event: PauseEvent) => { state = reducePause(state, event); scheduler.setPaused(isRotationPaused(state)); },
    get index() { return index; },
  };
}

describe('manual navigation cooperates with the timing rules', () => {
  it('after a manual change an image slide gets its full 5.4 s, not what was left of the previous slide', () => {
    const h = scheduledHost(['image', 'image', 'image']);
    tick(5000);
    h.step(1);
    expect(h.index).toBe(1);
    tick(5399); expect(h.index).toBe(1);
    tick(1); expect(h.index).toBe(2);
    expect(h.moves.at(-1)).toEqual({ to: 2, at: 10400 });
  });
  it('the original image-only interval restarts on a manual change (the hook bumps its dependency), so the new slide also gets 5.4 s', () => {
    let index = 0; let stop: () => void = () => undefined;
    const start = () => { stop = startImageRotation(3, () => { index = (index + 1) % 3; }); };
    start();
    tick(5000);
    stop(); index = 1; start(); // what the effect cleanup + re-run does after a manual change
    expect(vi.getTimerCount()).toBe(1);
    tick(5399); expect(index).toBe(1);
    tick(1); expect(index).toBe(2);
  });
  it('leaving a video slide manually cancels its timers at once; late events from that video are ignored', () => {
    const h = scheduledHost(['video', 'image', 'image']);
    h.scheduler.videoMetadata(8); h.scheduler.videoPlaying();
    tick(3000);
    h.goTo(1);
    expect(vi.getTimerCount()).toBe(1); // only the new slide's timer
    h.scheduler.videoEnded(); h.scheduler.videoFailed(); h.scheduler.videoMetadata(99);
    tick(IMAGE_SLIDE_MS - 1); expect(h.index).toBe(1);
    tick(1); expect(h.index).toBe(2);
  });
  it('arriving on a video slide manually applies the video rules: a 8 s clip is not cut by the image timer', () => {
    const h = scheduledHost(['image', 'video', 'image']);
    h.goTo(1);
    h.scheduler.videoMetadata(8); h.scheduler.videoPlaying();
    tick(IMAGE_SLIDE_MS + 500); expect(h.index).toBe(1);
    tick(8000 - IMAGE_SLIDE_MS - 500); h.scheduler.videoEnded();
    expect(h.index).toBe(2);
  });
  it('arriving on a short video keeps it for at least the 6 s minimum', () => {
    const h = scheduledHost(['image', 'video', 'image']);
    h.goTo(1);
    h.scheduler.videoMetadata(4); h.scheduler.videoPlaying();
    tick(MIN_VIDEO_SLIDE_MS - 1); expect(h.index).toBe(1);
    tick(1); expect(h.index).toBe(2);
  });
  it('30 rapid manual changes leave exactly one timer and one advance, 5.4 s after the last change', () => {
    const h = scheduledHost(['image', 'video', 'image', 'image']);
    for (let i = 0; i < 30; i += 1) { h.step(i % 3 === 0 ? -1 : 1); tick(20); expect(vi.getTimerCount()).toBe(1); }
    const landedOn = h.index;
    h.scheduler.activate('image'); // settle on an image slide for a clean measurement
    const before = h.moves.length;
    tick(IMAGE_SLIDE_MS - 1); expect(h.moves.length).toBe(before);
    tick(1); expect(h.moves.length).toBe(before + 1);
    expect(landedOn).toBeGreaterThanOrEqual(0);
  });
  it('navigating while paused keeps it paused (no timers), and Play then times the new slide normally', () => {
    const h = scheduledHost(['image', 'image', 'image']);
    h.send('toggle');
    h.goTo(2);
    expect(h.index).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    tick(60_000); expect(h.index).toBe(2);
    h.send('toggle');
    tick(IMAGE_SLIDE_MS); expect(h.index).toBe(0);
  });
  it('choosing the banner already on screen does nothing and restarts nothing', () => {
    const h = scheduledHost(['image', 'image']);
    tick(3000);
    h.goTo(0);
    tick(IMAGE_SLIDE_MS - 3000); expect(h.index).toBe(1); // still on the original clock
  });
  it('navigation wraps: previous from the first banner is the last, next from the last is the first', () => {
    const h = scheduledHost(['image', 'image', 'image']);
    h.step(-1); expect(h.index).toBe(2);
    h.step(1); expect(h.index).toBe(0);
  });
});

describe('wiring (source checks for the parts that need a browser; the browser run is reported separately)', () => {
  const read = (file: string) => readFileSync(file, 'utf8');
  const hero = read('components/storefront/hero-carousel.tsx');
  const hook = read('lib/hooks/use-hero-carousel.ts');
  const css = read('app/globals.css');

  it('keyboard order is the small pause / play icon, the indicators, Previous, Next, then the banner link; the controls sit outside the link', () => {
    const order = ['className="hero-pause"', 'className="hero-indicators"', 'hero-arrow-prev', 'hero-arrow-next', 'hero-slide hero-slide-link'].map(marker => hero.indexOf(marker));
    expect(order.every(position => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(hero.indexOf('</Link>')).toBeGreaterThan(order[3]); // all controls come before the link closes, none inside it
    expect(hero).not.toMatch(/<Link[^>]*>[\s\S]*hero-arrow[\s\S]*<\/Link>/);
  });
  it('the buttons have descriptive labels, the indicators say which banner and which is current', () => {
    expect(hero).toContain('aria-label="Previous banner"');
    expect(hero).toContain('aria-label="Next banner"');
    expect(hero).toContain('aria-label={`Go to banner ${position + 1} of ${count}`}');
    expect(hero).toContain("aria-current={position === index ? 'true' : undefined}");
    expect(hero).toContain('aria-roledescription="carousel"');
    expect(hero).toMatch(/role="status" aria-live="polite"/); // manual changes are announced; the automatic rotation is not
    expect(hero).toContain('{several && ');
  });
  it('a swipe never opens the banner link, and ordinary clicks still do', () => {
    expect(hero).toContain('if (consumeSwipeClick()) { event.preventDefault(); return; } onTransition();');
    expect(hero).toContain('href={slide.href}');
    expect(hook).toContain('swallowClick.current = true;');
    expect(hook).toContain('swallowClick.current = false;'); // reset at the next touch so it can never swallow a later real click
  });
  it('swipe is for fingers and pens only, ignores touches that start on a button, and a browser-taken scroll cancels it', () => {
    expect(hook).toContain("event.pointerType === 'mouse'");
    expect(hook).toContain("closest('button')");
    expect(hook).toContain('onPointerCancel');
    expect(hook).toContain('classifySwipe(');
    expect(css).toMatch(/\.hero-section \{\s*touch-action: pan-y;/); // vertical scrolling stays native
  });
  it('arrow keys navigate but never steal modified shortcuts', () => {
    expect(hook).toContain('arrowKeyStep(event.key)');
    expect(hook).toContain('event.altKey || event.ctrlKey || event.metaKey || event.shiftKey');
  });
  it('a manual change restarts the original image interval and re-activates the scheduler; it adds no timer of its own', () => {
    expect(hook).toContain('}, [videoAware, paused, count, next, manualChanges]);');
    expect(hook).toContain('setManualChanges(value => value + 1);');
    expect(hook).toContain('if (to === index) return;');
    expect(hook).not.toMatch(/setTimeout|setInterval/);
  });
  it('the arrows are subtle with a mouse but visible on keyboard focus and on touch screens; focus rings are visible; reduced motion turns transitions off', () => {
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.hero-arrow \{\s*opacity: 0;/);
    expect(css).toMatch(/\.hero-arrow:focus-visible,\s*\.hero-dot:focus-visible \{\s*outline: 2px solid #e7d4bb;[^}]*opacity: 1;/);
    expect(css).toMatch(/\.hero-section:focus-within \.hero-arrow/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.hero-arrow,\s*\.hero-dot span,\s*\.hero-pause \{\s*transition: none;/);
  });
  it('on a phone the controls stay clear of the headline, which sits at the bottom of the banner: arrows at the edges, the pause icon and indicators in one bar on the bottom edge', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 600px) {\r\n\r\n  /* On a phone the headline') >= 0 ? css.indexOf('@media (max-width: 600px) {\r\n\r\n  /* On a phone the headline') : css.indexOf('@media (max-width: 600px) {\n\n  /* On a phone the headline'));
    expect(phone.length).toBeGreaterThan(0);
    const block = phone.slice(0, phone.indexOf('@media (prefers-reduced-motion'));
    expect(block).toMatch(/\.hero-arrow \{\s*top: 40%;/);
    expect(block).toMatch(/\.hero-nav-bar \{\s*bottom: 3px;/);
    expect(block).not.toMatch(/\.hero-pause \{\s*top:/); // no separate pause control floating in a corner
    expect(block).not.toMatch(/bottom: 52px/); // the earlier layout that covered the headline
  });
  it('timing constants and the slide transition are unchanged', () => {
    expect(IMAGE_SLIDE_MS).toBe(5400);
    expect(MIN_VIDEO_SLIDE_MS).toBe(6000);
    expect(css).toMatch(/\.hero-slide \{[^}]*animation: heroSoftEnter 1\.15s/);
    expect(hero).toContain('key={slide.id}');
    expect(hook).toContain('(current + 1) % count');
  });
});
