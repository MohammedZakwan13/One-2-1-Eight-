import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_SLIDE_MS, MIN_VIDEO_SLIDE_MS, createSlideScheduler, startImageRotation, type SlideKind, type SlideScheduler } from '@/lib/hero-timing';
import { INITIAL_PAUSE, focusEntersCarousel, isRotationPaused, pointerPausesRotation, reducePause, syncVideoPlayback, type PauseEvent, type PauseState } from '@/lib/hero-pause';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });
const tick = (ms: number) => vi.advanceTimersByTime(ms);

describe('pause rules', () => {
  const run = (...events: PauseEvent[]) => events.reduce<PauseState>(reducePause, INITIAL_PAUSE);

  it('the Pause / Play button toggles the sticky pause', () => {
    expect(run('toggle')).toEqual({ user: true, hover: false });
    expect(run('toggle', 'toggle')).toEqual({ user: false, hover: false });
  });
  it('keyboard focus entering the carousel pauses it, and nothing but the Play control resumes it', () => {
    const paused = run('keyboard-focus-enter');
    expect(paused.user).toBe(true);
    // there is no "focus left" event at all: focus leaving cannot resume the carousel
    expect(run('keyboard-focus-enter', 'pointer-enter', 'pointer-leave').user).toBe(true);
    expect(run('keyboard-focus-enter', 'toggle').user).toBe(false); // Play
    expect(isRotationPaused(run('keyboard-focus-enter'))).toBe(true);
  });
  it('entering again by keyboard while already paused changes nothing (same state object, so no re-render)', () => {
    const once = run('keyboard-focus-enter');
    expect(reducePause(once, 'keyboard-focus-enter')).toBe(once);
  });
  it('hover pauses temporarily and never overrides an explicit pause', () => {
    expect(isRotationPaused(run('pointer-enter'))).toBe(true);
    expect(isRotationPaused(run('pointer-enter', 'pointer-leave'))).toBe(false);
    expect(isRotationPaused(run('toggle', 'pointer-enter', 'pointer-leave'))).toBe(true); // the visitor paused it: leaving does not resume
    expect(isRotationPaused(run('pointer-enter', 'toggle', 'pointer-leave'))).toBe(true);
    expect(isRotationPaused(run('pointer-enter', 'toggle', 'toggle', 'pointer-leave'))).toBe(false);
  });
  it('repeated enter / leave events do not change state (so no duplicate effects)', () => {
    const hovering = run('pointer-enter');
    expect(reducePause(hovering, 'pointer-enter')).toBe(hovering);
    expect(reducePause(INITIAL_PAUSE, 'pointer-leave')).toBe(INITIAL_PAUSE);
  });
  it('focus only counts as ENTERING when it comes from outside; moving between the controls inside does not re-pause after Play', () => {
    const inside = new Set<unknown>(['pause-button', 'slide-link']);
    const container = { contains: (node: unknown) => inside.has(node) };
    expect(focusEntersCarousel(null, container)).toBe(true); // from nowhere (first Tab into the page)
    expect(focusEntersCarousel('search-box', container)).toBe(true);
    expect(focusEntersCarousel('pause-button', container)).toBe(false);
    expect(focusEntersCarousel('slide-link', container)).toBe(false);
  });
  it('a mouse or a pen hovers; a finger tap does not', () => {
    expect(pointerPausesRotation('mouse')).toBe(true);
    expect(pointerPausesRotation('pen')).toBe(true);
    expect(pointerPausesRotation('touch')).toBe(false);
  });
});

/** Mirrors the hook: the original interval for image-only banners is stopped when paused and started again when resumed. */
function imageOnlyHost(slideCount = 3) {
  let state = INITIAL_PAUSE;
  let index = 0;
  let stop: (() => void) | null = null;
  const sync = () => {
    const paused = isRotationPaused(state);
    if (paused && stop) { stop(); stop = null; }
    if (!paused && !stop) stop = startImageRotation(slideCount, () => { index = (index + 1) % slideCount; });
  };
  sync();
  return { send: (event: PauseEvent) => { state = reducePause(state, event); sync(); }, get index() { return index; } };
}

describe('pause and resume on image slides (the original 5.4 s interval)', () => {
  it('hovering stops the rotation; leaving resumes it with the same 5.4 s and exactly one timer', () => {
    const h = imageOnlyHost();
    tick(3000);
    h.send('pointer-enter');
    expect(vi.getTimerCount()).toBe(0);
    tick(60_000); expect(h.index).toBe(0);
    h.send('pointer-leave');
    expect(vi.getTimerCount()).toBe(1);
    tick(IMAGE_SLIDE_MS - 1); expect(h.index).toBe(0);
    tick(1); expect(h.index).toBe(1);
  });
  it('after an explicit pause, hovering and leaving never resumes; only Play does, with one timer', () => {
    const h = imageOnlyHost();
    h.send('toggle');
    h.send('pointer-enter'); h.send('pointer-leave');
    expect(vi.getTimerCount()).toBe(0);
    tick(60_000); expect(h.index).toBe(0);
    h.send('toggle'); // Play
    expect(vi.getTimerCount()).toBe(1);
    tick(IMAGE_SLIDE_MS); expect(h.index).toBe(1);
  });
  it('keyboard focus pauses; focus leaving does nothing; Play resumes; moving focus inside afterwards does not pause again', () => {
    const h = imageOnlyHost();
    h.send('keyboard-focus-enter');
    expect(vi.getTimerCount()).toBe(0);
    tick(30_000); expect(h.index).toBe(0); // focus has "left" (no event): still paused
    h.send('toggle'); // Play
    expect(vi.getTimerCount()).toBe(1);
    // Tab from the Pause button to the slide link: not an "enter" (see focusEntersCarousel), so nothing is dispatched
    tick(IMAGE_SLIDE_MS); expect(h.index).toBe(1);
  });
  it('50 rapid hover in/out cycles never leave more than one timer and advance once per 5.4 s after the last leave', () => {
    const h = imageOnlyHost();
    for (let i = 0; i < 50; i += 1) { h.send('pointer-enter'); expect(vi.getTimerCount()).toBe(0); h.send('pointer-leave'); expect(vi.getTimerCount()).toBe(1); }
    tick(IMAGE_SLIDE_MS - 1); expect(h.index).toBe(0);
    tick(1); expect(h.index).toBe(1);
    tick(IMAGE_SLIDE_MS); expect(h.index).toBe(2);
  });
  it('the interval itself, the order and the 5.4 s value are unchanged', () => {
    expect(IMAGE_SLIDE_MS).toBe(5400);
    const h = imageOnlyHost(3);
    tick(IMAGE_SLIDE_MS * 4);
    expect(h.index).toBe(1); // 0 -> 1 -> 2 -> 0 -> 1
  });
});

/** Mirrors the hook for carousels with video: the scheduler is paused / resumed, and the visible video is synced to the same state. */
function videoHost(kinds: SlideKind[]) {
  let state = INITIAL_PAUSE;
  let index = 0;
  const moves: number[] = [];
  const video = fakeVideo();
  const scheduler: SlideScheduler = createSlideScheduler(() => { index = (index + 1) % kinds.length; moves.push(Date.now()); scheduler.activate(kinds[index]); });
  scheduler.activate(kinds[0]);
  const apply = () => { const paused = isRotationPaused(state); scheduler.setPaused(paused); syncVideoPlayback(video, paused, () => undefined); };
  return { scheduler, video, moves, send: (event: PauseEvent) => { state = reducePause(state, event); apply(); }, get index() { return index; } };
}

function fakeVideo() {
  const v = { paused: true, ended: false, plays: 0, pauses: 0, play: () => { v.plays += 1; v.paused = false; return Promise.resolve(); }, pause: () => { v.pauses += 1; v.paused = true; } };
  return v;
}

describe('pause and resume on video slides', () => {
  it('hovering pauses the video and the carousel; leaving continues the same video and its ending still advances', () => {
    const c = videoHost(['video', 'image']);
    c.scheduler.videoMetadata(8); c.scheduler.videoPlaying(); c.video.paused = false; // it is playing
    tick(3000);
    c.send('pointer-enter');
    expect(c.video.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    tick(60_000); expect(c.index).toBe(0);
    c.send('pointer-leave');
    expect(c.video.paused).toBe(false);
    expect(c.video.plays).toBe(1); // resumed once, not restarted twice
    c.scheduler.videoPlaying();
    expect(vi.getTimerCount()).toBe(1);
    tick(5000); c.scheduler.videoEnded();
    expect(c.index).toBe(1);
  });
  it('an explicit pause survives hover in and out; Play resumes the video once', () => {
    const c = videoHost(['video', 'image']);
    c.scheduler.videoMetadata(8); c.scheduler.videoPlaying(); c.video.paused = false;
    c.send('toggle');
    c.send('pointer-enter'); c.send('pointer-leave');
    expect(c.video.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    c.send('toggle');
    expect(c.video.plays).toBe(1);
    expect(c.video.paused).toBe(false);
  });
  it('keyboard focus pauses a short looping video too; Play brings back the minimum-time countdown', () => {
    const c = videoHost(['video', 'image']);
    c.scheduler.videoMetadata(4); c.scheduler.videoPlaying(); c.video.paused = false;
    tick(2000);
    c.send('keyboard-focus-enter');
    tick(60_000); expect(c.index).toBe(0);
    c.send('toggle');
    tick(MIN_VIDEO_SLIDE_MS - 1); expect(c.index).toBe(0);
    tick(1); expect(c.index).toBe(1);
  });
  it('many hover cycles never stack timers or play() calls', () => {
    const c = videoHost(['video', 'image']);
    c.scheduler.videoMetadata(9); c.scheduler.videoPlaying(); c.video.paused = false;
    for (let i = 0; i < 25; i += 1) { c.send('pointer-enter'); c.send('pointer-leave'); c.scheduler.videoPlaying(); expect(vi.getTimerCount()).toBeLessThanOrEqual(1); }
    expect(c.video.plays).toBe(25); // exactly one resume per leave
    expect(c.video.paused).toBe(false);
  });
  it('a clip that finished while paused is not restarted by resuming, and the carousel moves on', () => {
    const c = videoHost(['video', 'image']);
    c.scheduler.videoMetadata(8); c.scheduler.videoPlaying(); c.video.paused = false;
    c.send('pointer-enter');
    c.video.ended = true; c.scheduler.videoEnded(); // the last frame arrived just as the pointer entered
    c.send('pointer-leave');
    expect(c.video.plays).toBe(0);
    expect(c.index).toBe(1);
  });
});

describe('video playback follows the carousel without duplicating playback', () => {
  it('plays a fresh video once, and further "keep playing" syncs do not call play() again', () => {
    const v = fakeVideo();
    syncVideoPlayback(v, false, () => undefined);
    syncVideoPlayback(v, false, () => undefined);
    syncVideoPlayback(v, false, () => undefined);
    expect(v.plays).toBe(1);
  });
  it('pausing always sends pause(), also before the video has started, so autoplay cannot begin while the carousel is paused', () => {
    const v = fakeVideo(); // not started yet
    syncVideoPlayback(v, true, () => undefined);
    expect(v.pauses).toBe(1);
    expect(v.plays).toBe(0);
  });
  it('a play() the browser refuses is reported so the poster can be shown', async () => {
    const refused = vi.fn();
    const v = { paused: true, ended: false, play: () => Promise.reject(new Error('NotAllowedError')), pause: () => undefined };
    syncVideoPlayback(v, false, refused);
    await Promise.resolve(); await Promise.resolve();
    expect(refused).toHaveBeenCalledTimes(1);
  });
  it('a play() that was only interrupted by a pause or a reload (AbortError) is not a refusal, so the video is not given up on', async () => {
    const refused = vi.fn();
    const abort = Object.assign(new Error('The play() request was interrupted by a call to load()'), { name: 'AbortError' });
    const v = { paused: true, ended: false, play: () => Promise.reject(abort), pause: () => undefined };
    syncVideoPlayback(v, false, refused);
    await Promise.resolve(); await Promise.resolve();
    expect(refused).not.toHaveBeenCalled();
    const blocked = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    syncVideoPlayback({ ...v, play: () => Promise.reject(blocked) }, false, refused);
    await Promise.resolve(); await Promise.resolve();
    expect(refused).toHaveBeenCalledTimes(1);
  });
  it('an old browser whose play() returns nothing is handled', () => {
    const v = { paused: true, ended: false, play: () => undefined, pause: () => undefined };
    expect(() => syncVideoPlayback(v, false, () => undefined)).not.toThrow();
  });
});

describe('accessibility wiring (source checks: these files need a browser to run)', () => {
  const read = (file: string) => readFileSync(file, 'utf8');
  const home = read('components/storefront/hero-carousel.tsx'); // the hero markup (the homepage only mounts it)

  it('the Pause / Play control is the FIRST focusable element in the carousel: it comes before the slide link and nothing has a positive tabindex', () => {
    expect(home.indexOf('className="hero-pause"')).toBeGreaterThan(0);
    expect(home.indexOf('className="hero-pause"')).toBeLessThan(home.indexOf('hero-slide hero-slide-link'));
    expect(home).not.toMatch(/tabIndex=\{?["']?[1-9]/);
    expect(read('components/storefront/hero-media.tsx')).toContain('tabIndex={-1}'); // the decorative video is never a tab stop
    expect(read('app/globals.css')).toMatch(/\.hero-nav-bar \{[^}]*position: absolute;/); // the bar holding the icon is placed by CSS, whatever the page order
  });
  it('the prominent bottom-right PAUSE / PLAY pill is gone: no visible text, no pill shape, no corner placement; only a small round icon in the navigation bar', () => {
    expect(home).not.toMatch(/>PAUSE<|>PLAY<|'PAUSE'|'PLAY'/);
    const css = read('app/globals.css');
    const rule = /\.hero-pause \{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/width: 26px;/);
    expect(rule).toMatch(/height: 26px;/);
    expect(rule).toMatch(/border-radius: 50%;/);
    expect(rule).not.toMatch(/position: absolute|999px|letter-spacing|right:/);
    expect(home.indexOf('hero-pause')).toBeGreaterThan(home.indexOf('className="hero-nav-bar"')); // inside the same bar as the indicators
    expect(home.indexOf('hero-pause')).toBeLessThan(home.indexOf('className="hero-indicators"'));
  });
  it('the button is a real toggle: aria-pressed is true exactly when paused, and its label always names the action that a press would do', () => {
    expect(home).toContain('type="button" className="hero-pause" onClick={togglePaused}');
    expect(home).toContain('aria-pressed={userPaused}');
    expect(home).toContain("aria-label={userPaused ? 'Play automatic slideshow' : 'Pause automatic slideshow'}");
    expect(home).toContain("title={userPaused ? 'Play automatic slideshow' : 'Pause automatic slideshow'}"); // icon-only: the name is the label, also shown as a tooltip
    expect(home).toContain('aria-hidden="true"'); // the icon itself is decoration
  });
  it('keyboard focus pauses and never resumes by itself: there is no blur / focus-out handler, no focus state to clear', () => {
    const hook = read('lib/hooks/use-hero-carousel.ts');
    expect(hook).toContain('onFocusCapture');
    expect(hook).toContain("dispatchPause('keyboard-focus-enter')");
    expect(hook).toContain('focusEntersCarousel(event.relatedTarget, event.currentTarget)');
    expect(hook).not.toMatch(/onBlur|onFocusOut|setFocusPaused|focusPaused/);
  });
  it('hover pauses for a mouse or pen only, and leaving resumes unless the visitor paused', () => {
    const hook = read('lib/hooks/use-hero-carousel.ts');
    expect(hook).toContain('onPointerEnter');
    expect(hook).toContain('onPointerLeave');
    expect(hook).toContain('pointerPausesRotation(event.pointerType)');
    expect(hook).toContain('const paused = isRotationPaused(pause);');
  });
  it('the video is synced through one helper, there is one video element, and timing / order / animation files keep their values', () => {
    const media = read('components/storefront/hero-media.tsx');
    expect(media).toContain('syncVideoPlayback(video, paused,');
    expect(media.match(/<video\b/g)).toHaveLength(1);
    expect(IMAGE_SLIDE_MS).toBe(5400);
    expect(MIN_VIDEO_SLIDE_MS).toBe(6000);
    expect(read('lib/hooks/use-hero-carousel.ts')).toContain('(current + 1) % count');
    expect(read('app/globals.css')).toMatch(/\.hero-slide \{[^}]*animation: heroFade \.7s ease both/);
  });
});
