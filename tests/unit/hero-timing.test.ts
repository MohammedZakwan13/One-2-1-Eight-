import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeroMediaFields } from '@/lib/hero-media';
import {
  IMAGE_SLIDE_MS, MIN_VIDEO_SLIDE_MS, VIDEO_DURATION_TIP, VIDEO_STALL_GRACE_MS, VIDEO_START_TIMEOUT_MS, VIDEO_TOO_LONG_NOTE,
  RECOMMENDED_VIDEO_MAX_SECONDS, RECOMMENDED_VIDEO_TOLERANCE_SECONDS, createSlideScheduler, formatVideoDuration, hasVideoSlides, slideKind, startImageRotation, videoDurationAdvice, type SlideKind, type SlideScheduler,
} from '@/lib/hero-timing';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

/** A tiny stand-in for the carousel component: one current slide, advancing re-activates the next. */
function carousel(kinds: SlideKind[]) {
  const moves: { to: number; at: number }[] = [];
  let index = 0;
  const scheduler: SlideScheduler = createSlideScheduler(() => {
    index = (index + 1) % kinds.length;
    moves.push({ to: index, at: Date.now() });
    scheduler.activate(kinds[index]);
  });
  scheduler.activate(kinds[0]);
  return { scheduler, moves, get index() { return index; } };
}
const tick = (ms: number) => vi.advanceTimersByTime(ms);

describe('image slides keep their original timing', () => {
  it('the original rotation: one interval, every 5.4 s, in order, never earlier', () => {
    const order: number[] = []; let index = 0;
    const stop = startImageRotation(3, () => { index = (index + 1) % 3; order.push(index); });
    tick(IMAGE_SLIDE_MS - 1); expect(order).toEqual([]);
    tick(1); expect(order).toEqual([1]);
    tick(IMAGE_SLIDE_MS); tick(IMAGE_SLIDE_MS); expect(order).toEqual([1, 2, 0]);
    stop();
    tick(IMAGE_SLIDE_MS * 4); expect(order).toEqual([1, 2, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('the interval is exactly 5400 ms, defined once, and a single banner never starts a timer', () => {
    expect(IMAGE_SLIDE_MS).toBe(5400);
    expect(startImageRotation(1, () => undefined)).toBeTypeOf('function');
    expect(vi.getTimerCount()).toBe(0);
    expect(startImageRotation(0, () => undefined)).toBeTypeOf('function');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('inside the video-aware scheduler an image slide also lasts 5.4 s', () => {
    const c = carousel(['image', 'image']);
    tick(5399); expect(c.index).toBe(0);
    tick(1); expect(c.index).toBe(1);
    tick(5400); expect(c.index).toBe(0);
  });
});

describe('video slides are timed by their real playback', () => {
  const play = (c: ReturnType<typeof carousel>, seconds: number, startAt = 200) => { tick(startAt); c.scheduler.videoMetadata(seconds); c.scheduler.videoPlaying(); };

  it('a 4 s clip loops and stays for at least 6 s, advancing once, and loop restarts never restart the countdown', () => {
    const c = carousel(['video', 'image']);
    play(c, 4);
    tick(3000); c.scheduler.videoPlaying(); // the loop wrapped round
    tick(1500); c.scheduler.videoPlaying();
    tick(MIN_VIDEO_SLIDE_MS - 4700 - 1); expect(c.index).toBe(0); // 5999 ms in
    tick(1); expect(c.index).toBe(1);
    expect(c.moves).toEqual([{ to: 1, at: 6000 }]);
  });
  it('a short clip that does "end" (unknown loop state) does not shorten its minimum time', () => {
    const c = carousel(['video', 'image']);
    play(c, 4); tick(4000); c.scheduler.videoEnded(); tick(1000); expect(c.index).toBe(0);
    tick(1000); expect(c.index).toBe(1);
  });

  it.each([6, 8, 10])('a %i s clip plays to its end, ignores the 5.4 s image timer, and advances when it ends', seconds => {
    const c = carousel(['video', 'image']);
    play(c, seconds, 0);
    tick(IMAGE_SLIDE_MS + 100); expect(c.index).toBe(0); // the image timer would already have fired
    tick(seconds * 1000 - IMAGE_SLIDE_MS - 100 - 1); expect(c.index).toBe(0); // not before its last moment
    tick(1); c.scheduler.videoEnded();
    expect(c.index).toBe(1);
    expect(c.moves[0].at).toBe(seconds * 1000);
  });
  it('a 15 s clip is never cut short: nothing happens at 5.4, 6, 10 or 14 s, and it advances at its end', () => {
    const c = carousel(['video', 'image']);
    play(c, 15, 0);
    for (const at of [5400, 6000, 10000, 14000]) { tick(at - Date.now()); expect(c.index, `${at} ms`).toBe(0); }
    tick(1000); c.scheduler.videoEnded();
    expect(c.index).toBe(1);
    expect(c.moves[0].at).toBe(15000);
  });
  it('if a 6 s+ clip stalls and never reports "ended", a watchdog moves on after its length plus the grace, never later', () => {
    const c = carousel(['video', 'image']);
    play(c, 8, 0);
    tick(8000 + VIDEO_STALL_GRACE_MS - 1); expect(c.index).toBe(0);
    tick(1); expect(c.index).toBe(1);
  });
  it('the next slide starts its own timing from the moment it appears', () => {
    const c = carousel(['video', 'image', 'image']);
    play(c, 8, 0); tick(8000); c.scheduler.videoEnded();
    expect(c.index).toBe(1);
    tick(5399); expect(c.index).toBe(1);
    tick(1); expect(c.index).toBe(2);
    tick(5400); expect(c.index).toBe(0);
    expect(c.moves.map(m => m.at)).toEqual([8000, 13400, 18800]);
  });
});

describe('a video that cannot play never freezes the carousel', () => {
  it('an error shows the poster and advances after the minimum time, not before', () => {
    const c = carousel(['video', 'image']);
    tick(1000); c.scheduler.videoFailed();
    tick(4999); expect(c.index).toBe(0);
    tick(1); expect(c.index).toBe(1);
    expect(c.moves[0].at).toBe(MIN_VIDEO_SLIDE_MS);
  });
  it('a failure after the minimum has passed advances at once', () => {
    const c = carousel(['video', 'image']);
    c.scheduler.videoMetadata(8); c.scheduler.videoPlaying();
    tick(7000); c.scheduler.videoFailed(); tick(0);
    expect(c.index).toBe(1);
  });
  it('missing, zero, infinite or NaN duration does not freeze the carousel: it moves on after the minimum', () => {
    for (const duration of [undefined, NaN, Infinity, 0, -1]) {
      const c = carousel(['video', 'image']);
      if (duration !== undefined) { c.scheduler.videoMetadata(duration); c.scheduler.videoPlaying(); }
      tick(MIN_VIDEO_SLIDE_MS - 1); expect(c.index, String(duration)).toBe(0);
      tick(1); expect(c.index, String(duration)).toBe(1);
      c.scheduler.dispose();
    }
  });
  it('a long clip that never starts (blocked autoplay, stalled download) is given up on and the poster is used', () => {
    const c = carousel(['video', 'image']);
    c.scheduler.videoMetadata(12);
    tick(VIDEO_START_TIMEOUT_MS - 1); expect(c.index).toBe(0);
    tick(1); // given up on; the minimum time has also passed by now
    tick(MIN_VIDEO_SLIDE_MS); expect(c.index).toBe(1);
    expect(c.moves[0].at).toBeLessThanOrEqual(VIDEO_START_TIMEOUT_MS + 1000);
  });
  it('metadata that arrives after the minimum cannot resurrect a slide that already moved on', () => {
    const c = carousel(['video', 'image']);
    tick(MIN_VIDEO_SLIDE_MS); expect(c.index).toBe(1);
    c.scheduler.videoMetadata(30); c.scheduler.videoPlaying(); // late events from the old video
    tick(IMAGE_SLIDE_MS - 1); expect(c.index).toBe(1);
    tick(1); expect(c.index).toBe(0);
  });
});

describe('only the current slide controls advancement; timers never overlap', () => {
  it('rapid slide changes leave exactly one pending decision and one advance', () => {
    const advance = vi.fn();
    const s = createSlideScheduler(advance);
    for (let i = 0; i < 100; i += 1) { s.activate(i % 2 ? 'video' : 'image'); tick(10); }
    s.activate('image');
    expect(vi.getTimerCount()).toBe(1);
    tick(IMAGE_SLIDE_MS - 1); expect(advance).not.toHaveBeenCalled();
    tick(1); expect(advance).toHaveBeenCalledTimes(1);
  });
  it('repeated video events never stack timers', () => {
    const s = createSlideScheduler(() => undefined);
    s.activate('video');
    for (let i = 0; i < 20; i += 1) { s.videoMetadata(9); s.videoPlaying(); expect(vi.getTimerCount()).toBe(1); }
  });
  it('leaving a slide cancels its timers: the old slide can no longer advance the carousel', () => {
    const advance = vi.fn();
    const s = createSlideScheduler(advance);
    s.activate('video'); s.videoMetadata(8); s.videoPlaying();
    tick(3000);
    s.activate('image'); // the carousel moved elsewhere
    tick(IMAGE_SLIDE_MS - 1); expect(advance).not.toHaveBeenCalled();
    s.videoEnded(); s.videoFailed(); tick(60_000); // late events from the old video are ignored
    expect(advance).toHaveBeenCalledTimes(1);
  });
  it('ended and a timer firing together advance only once', () => {
    const advance = vi.fn();
    const s = createSlideScheduler(advance);
    s.activate('video'); s.videoMetadata(6); s.videoPlaying();
    tick(6000); s.videoEnded(); s.videoEnded();
    expect(advance).toHaveBeenCalledTimes(1);
  });
  it('dispose clears everything (unmount)', () => {
    const s = createSlideScheduler(() => undefined);
    s.activate('video'); s.videoMetadata(9); s.videoPlaying();
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('pause, resume and a hidden tab', () => {
  it('pausing stops an image slide; resuming gives it its normal 5.4 s again', () => {
    const c = carousel(['image', 'image']);
    tick(2000); c.scheduler.setPaused(true);
    tick(60_000); expect(c.index).toBe(0); expect(vi.getTimerCount()).toBe(0);
    c.scheduler.setPaused(false);
    tick(5399); expect(c.index).toBe(0);
    tick(1); expect(c.index).toBe(1);
  });
  it('a paused video does not advance; once resumed it advances when it ends', () => {
    const c = carousel(['video', 'image']);
    c.scheduler.videoMetadata(8); c.scheduler.videoPlaying();
    tick(3000); c.scheduler.setPaused(true);
    tick(60_000); expect(c.index).toBe(0);
    c.scheduler.setPaused(false); c.scheduler.videoPlaying();
    tick(4000); c.scheduler.videoEnded();
    expect(c.index).toBe(1);
  });
  it('a clip that ends at the very moment the visitor pauses moves on as soon as playback resumes', () => {
    const c = carousel(['video', 'image']);
    c.scheduler.videoMetadata(8); c.scheduler.videoPlaying();
    c.scheduler.setPaused(true); c.scheduler.videoEnded(); expect(c.index).toBe(0);
    c.scheduler.setPaused(false);
    expect(c.index).toBe(1);
  });
  it('pausing twice or resuming twice changes nothing', () => {
    const c = carousel(['image', 'image']);
    c.scheduler.setPaused(true); c.scheduler.setPaused(true);
    c.scheduler.setPaused(false); c.scheduler.setPaused(false);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('mixing images and videos', () => {
  it('uses the right timing for each slide in turn: image 5.4 s, 8 s video to its end, image 5.4 s, back round', () => {
    const c = carousel(['image', 'video', 'image']);
    tick(5400); expect(c.moves).toEqual([{ to: 1, at: 5400 }]);
    tick(100); c.scheduler.videoMetadata(8); c.scheduler.videoPlaying();
    tick(7900); c.scheduler.videoEnded();
    expect(c.moves.at(-1)).toEqual({ to: 2, at: 13400 });
    tick(5400); expect(c.moves.at(-1)).toEqual({ to: 0, at: 18800 });
    tick(5400); expect(c.moves.at(-1)).toEqual({ to: 1, at: 24200 });
  });
  it('the banner order is unchanged: 0, 1, 2, 0 ...', () => {
    const c = carousel(['image', 'image', 'image']);
    tick(5400 * 4);
    expect(c.moves.map(m => m.to)).toEqual([1, 2, 0, 1]);
  });
});

describe('desktop and mobile', () => {
  const base: HeroMediaFields = { desktopMediaType: 'video', desktopImage: '/d.webp', desktopVideo: '/d.mp4', mobileMediaType: 'image', mobileImage: '/m.webp', mobileVideo: '', useDesktopOnMobile: false };
  const desktop = { isMobile: false, reducedMotion: false };
  const phone = { isMobile: true, reducedMotion: false };

  it('each device is timed by the media it actually receives', () => {
    expect(slideKind(base, desktop)).toBe('video');
    expect(slideKind(base, phone)).toBe('image'); // a phone gets the image: normal 5.4 s timing
    expect(slideKind({ ...base, mobileMediaType: 'video', mobileVideo: '/m.mp4' }, phone)).toBe('video');
    expect(slideKind({ ...base, useDesktopOnMobile: true }, phone)).toBe('video');
    expect(slideKind({ ...base, mobileImage: '', useDesktopOnMobile: false }, phone)).toBe('video'); // empty mobile slot falls back to desktop
    expect(slideKind({ ...base, desktopVideo: '' }, desktop)).toBe('image'); // a video slot without a file is just the poster
  });
  it('an image slide keeps its type when the window crosses the phone breakpoint, so its timing is not reset', () => {
    const image: HeroMediaFields = { ...base, desktopMediaType: 'image', desktopVideo: '' };
    expect(slideKind(image, desktop)).toBe(slideKind(image, phone));
    expect(slideKind(image, { isMobile: null, reducedMotion: null })).toBe('image');
  });
  it('crossing the breakpoint on a video slide swaps the one video: no second timer, one advance', () => {
    const c = carousel(['video', 'image']);
    c.scheduler.videoMetadata(8); c.scheduler.videoPlaying();
    tick(2000);
    c.scheduler.videoSourceChanged(); // the desktop file is replaced by the mobile file
    expect(vi.getTimerCount()).toBe(1);
    c.scheduler.videoMetadata(9); c.scheduler.videoPlaying();
    expect(vi.getTimerCount()).toBe(1);
    tick(9000); c.scheduler.videoEnded();
    expect(c.moves).toHaveLength(1);
  });
  it('visitors who prefer reduced motion get the still image and normal image timing; so do pages not yet measured', () => {
    expect(slideKind(base, { isMobile: false, reducedMotion: true })).toBe('image');
    expect(slideKind(base, { isMobile: false, reducedMotion: null })).toBe('image');
    expect(slideKind(base, { isMobile: null, reducedMotion: false })).toBe('image');
  });
  it('banners with a video on either device switch the carousel to video-aware timing, from the data only', () => {
    expect(hasVideoSlides([base])).toBe(true);
    expect(hasVideoSlides([{ ...base, desktopMediaType: 'image', mobileMediaType: 'video' }])).toBe(true);
    expect(hasVideoSlides([{ ...base, desktopMediaType: 'image' }])).toBe(false);
    expect(hasVideoSlides([])).toBe(false);
  });
});

describe('admin guidance', () => {
  it('tells the admin the recommended length, and only warns (never blocks) above 10 s', () => {
    expect(VIDEO_DURATION_TIP).toBe('Recommended hero video duration: 6–10 seconds.');
    expect(videoDurationAdvice(10)).toBeNull();
    expect(videoDurationAdvice(6)).toBeNull();
    expect(videoDurationAdvice(3)).toBeNull();
    expect(videoDurationAdvice(10.01)).toBeNull(); // within the 0.5 s tolerance
    expect(videoDurationAdvice(10.6)).toBe(VIDEO_TOO_LONG_NOTE);
    expect(VIDEO_TOO_LONG_NOTE).toBe('This video is longer than recommended for an automatic hero carousel. Consider trimming it to 6–10 seconds for a better browsing experience.');
    for (const unknown of [undefined, null, NaN, Infinity]) expect(videoDurationAdvice(unknown as number)).toBeNull();
  });
  it('the uploader shows the tip and the note, and the upload size limit and validation are untouched', () => {
    const source = readFileSync('components/admin/hero-video-uploader.tsx', 'utf8');
    expect(source).toContain('VIDEO_DURATION_TIP');
    expect(source).toContain('videoDurationAdvice(lengths[value])');
    expect(source).toContain('onLoadedMetadata');
    expect(source).toContain('videoFileProblem(file)');
    expect(source).toContain('uploadBannerVideo(file')
  });
});

describe('duration advice has a 0.5 s tolerance and never blocks anything', () => {
  it.each([
    [9.98, false], [10.0, false], [10.04, false], [10.026667, false], [10.5, false], [10.6, true], [10.5000001, true], [15, true], [30, true],
  ])('%s s: advice shown = %s', (seconds, shown) => {
    expect(videoDurationAdvice(seconds)).toBe(shown ? VIDEO_TOO_LONG_NOTE : null);
  });
  it('the real Gemini clip (10.026667 s by the browser, "0:10" in the native player) no longer triggers the advice', () => {
    expect(videoDurationAdvice(10.026667)).toBeNull();
    expect(formatVideoDuration(10.026667)).toBe('10.03 s');
  });
  it('the threshold is exactly the recommended maximum plus the tolerance, and the recommendation text still says 6–10 seconds', () => {
    expect(RECOMMENDED_VIDEO_MAX_SECONDS).toBe(10);
    expect(RECOMMENDED_VIDEO_TOLERANCE_SECONDS).toBe(0.5);
    expect(VIDEO_DURATION_TIP).toBe('Recommended hero video duration: 6–10 seconds.');
    expect(VIDEO_TOO_LONG_NOTE).toContain('6–10 seconds');
  });
  it('shows the real length to two decimals', () => {
    expect(formatVideoDuration(9.98)).toBe('9.98 s');
    expect(formatVideoDuration(10)).toBe('10.00 s');
    expect(formatVideoDuration(10.04)).toBe('10.04 s');
    expect(formatVideoDuration(10.5)).toBe('10.50 s');
    expect(formatVideoDuration(10.6)).toBe('10.60 s');
    expect(formatVideoDuration(4)).toBe('4.00 s');
  });
  it('the advice follows the video that is currently in the field, so replacing a long video with a short one (or the reverse) updates it', () => {
    // the uploader keeps the measured length per file URL and looks up the CURRENT value
    const lengths: Record<string, number> = {};
    const adviceFor = (value: string) => videoDurationAdvice(lengths[value]);
    lengths['long.mp4'] = 14.2;
    expect(adviceFor('long.mp4')).toBe(VIDEO_TOO_LONG_NOTE);
    expect(adviceFor('replacement.mp4')).toBeNull(); // new file, length not read yet: no stale advice from the old one
    lengths['replacement.mp4'] = 8.4;
    expect(adviceFor('replacement.mp4')).toBeNull();
    lengths['third.mp4'] = 10.6;
    expect(adviceFor('third.mp4')).toBe(VIDEO_TOO_LONG_NOTE);
    expect(adviceFor('')).toBeNull(); // removed
    const source = readFileSync('components/admin/hero-video-uploader.tsx', 'utf8');
    expect(source).toContain('<video key={value}'); // a replaced file gets a fresh element, so its own metadata is read
    expect(source).toContain('[value]: seconds');
    expect(source).toContain('formatVideoDuration(lengths[value])');
  });
  it('it is advice only: nothing about the duration can reject an upload, on the browser or the server', () => {
    for (const file of ['lib/hero-media.ts', 'lib/backend/routes/hero-banners.ts', 'lib/backend/storage-errors.ts', 'lib/video-structure.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/RECOMMENDED_VIDEO|videoDurationAdvice|\.duration\b/);
    }
    const uploader = readFileSync('components/admin/hero-video-uploader.tsx', 'utf8');
    expect(uploader).not.toMatch(/setErrors\([^)]*videoDurationAdvice/); // the note is shown as a status message, never as an error
    expect(uploader).toContain('<div className="hb-note" role="status">');
  });
  it('the carousel still uses the real video duration, not the advice threshold: a 10.03 s and a 10.6 s clip each play to their end', () => {
    for (const seconds of [10.03, 10.6]) {
      const advance = vi.fn();
      const scheduler = createSlideScheduler(advance);
      scheduler.activate('video'); scheduler.videoMetadata(seconds); scheduler.videoPlaying();
      tick(seconds * 1000 - 1); expect(advance).not.toHaveBeenCalled();
      tick(1); scheduler.videoEnded();
      expect(advance).toHaveBeenCalledTimes(1);
    }
  });
  it('the scheduler timing constants are untouched', () => {
    expect(IMAGE_SLIDE_MS).toBe(5400);
    expect(MIN_VIDEO_SLIDE_MS).toBe(6000);
    expect(VIDEO_START_TIMEOUT_MS).toBe(5000);
    expect(VIDEO_STALL_GRACE_MS).toBe(4000);
    expect(readFileSync('lib/hero-timing.ts', 'utf8')).toContain('duration * 1000 < MIN_VIDEO_SLIDE_MS');
  });
});

describe('wiring (source checks: these files need a browser to run)', () => {
  const read = (file: string) => readFileSync(file, 'utf8');

  it('the homepage no longer owns a timer; the original interval lives in one place and is used for image-only banners', () => {
    const home = read('components/storefront/pages/home-page.tsx');
    const hero = read('components/storefront/hero-carousel.tsx');
    for (const source of [home, hero]) { expect(source).not.toMatch(/setInterval|setTimeout/); expect(source).not.toContain('5400'); }
    expect(home).toContain('<HeroCarousel slides={activeSlides}');
    expect(hero).toContain('key={slide.id}'); // the slide still remounts, so the existing fade-in animation still plays
    const hook = read('lib/hooks/use-hero-carousel.ts');
    expect(hook).toContain('startImageRotation(count, next)');
    expect(hook).toMatch(/if \(videoAware \|\| paused\) return;/);
    expect(hook).toContain('(current + 1) % count');
    expect(read('lib/hero-timing.ts')).toContain('setInterval(advance, IMAGE_SLIDE_MS)');
  });
  it('the scheduler runs only when a banner is a video; tab visibility is handled; timers and listeners are cleaned up on unmount', () => {
    const hook = read('lib/hooks/use-hero-carousel.ts');
    expect(hook).toContain("document.addEventListener('visibilitychange'");
    expect(hook).toContain("document.removeEventListener('visibilitychange'");
    expect(hook).toContain('scheduler.dispose()');
    expect(hook).toContain('list.removeEventListener');
    expect(hook).toMatch(/if \(!videoAware \|\| count < 2\) return;/);
  });
  it('a video stops when its slide goes away and when playback fails, and a refused play() falls back to the poster', () => {
    const media = read('components/storefront/hero-media.tsx');
    expect(media).toContain("video.removeAttribute('src')");
    expect(media).toContain('if (video && !video.getAttribute(\'src\')) video.src = src;'); // the file is put back after React\'s development-only unmount / remount check
    expect(media).toContain('video.pause()');
    expect(media).toContain('video.load()');
    expect(media).toContain('onError={fail}');
    expect(media).toContain('syncVideoPlayback(video, paused, () => { release(); setFailed(true); playback.onFailed(); })');
    expect(media).toContain('if (failed) return null; // the poster image underneath stays on screen');
    expect(media).toContain('video.muted = true');
    expect(media).toContain('autoPlay muted playsInline');
    expect(media).toContain('onLoadedMetadata');
    expect(media).toContain('onEnded={playback.onEnded}');
    expect(media).toContain('key={videoSrc}'); // one video at a time: a device change replaces it
  });
  it('the still image is rendered first and only the visitor\'s own device video is mounted', () => {
    const media = read('components/storefront/hero-media.tsx');
    expect(media.indexOf('<picture')).toBeLessThan(media.indexOf('<HeroVideo'));
    expect(media).toContain("slideKind(slide, env) === 'video'");
    expect(media).not.toMatch(/<video[\s\S]*<video/); // a single video element definition
  });
  it('a visible pause / play button with a text label controls the automatic movement, and keyboard focus entering the carousel pauses it', () => {
    const home = read('components/storefront/hero-carousel.tsx');
    expect(home).toContain('className="hero-pause"');
    expect(home).toContain('aria-pressed={userPaused}');
    expect(home).toContain('Pause automatic slideshow');
    expect(home).toContain('{...interactionProps}');
    expect(read('lib/hooks/use-hero-carousel.ts')).toContain(':focus-visible');
  });
  it('the existing slide transition and image handling are untouched', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/\.hero-slide \{[^}]*animation: heroFade \.7s ease both/);
    expect(css).toContain('@keyframes heroFade');
    const home = read('components/storefront/hero-carousel.tsx');
    expect(home).toContain('className="hero-slide hero-slide-link"');
    expect(home).toContain('<div className="hero-gradient" />');
    expect(home).toContain('slide.title.split');
  });
});
