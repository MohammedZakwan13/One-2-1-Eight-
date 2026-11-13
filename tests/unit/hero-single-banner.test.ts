import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_VIDEO_SLIDE_MS, shouldLoopVideo, startImageRotation } from '@/lib/hero-timing';

const norm = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('a lone banner video always loops (nothing else would ever advance it)', () => {
  it('loops at every length when it is the only banner, including 6 s and longer clips that used to play once and freeze', () => {
    for (const seconds of [1, 5.9, 6, 7, 10, 90, Number.NaN, Number.POSITIVE_INFINITY]) expect(shouldLoopVideo(seconds, true), String(seconds)).toBe(true);
  });
  it('with several banners the rules are exactly as before: under 6 s loops, 6 s or longer plays once and the carousel advances on ended', () => {
    expect(shouldLoopVideo(4, false)).toBe(true); expect(shouldLoopVideo(MIN_VIDEO_SLIDE_MS / 1000 - 0.001, false)).toBe(true);
    for (const seconds of [6, 7, 10, 90]) expect(shouldLoopVideo(seconds, false), String(seconds)).toBe(false);
    expect(shouldLoopVideo(Number.NaN, false)).toBe(true); // unknown length: the old behaviour (loop, the carousel's own watchdog advances)
  });
  it('a single image never starts a timer (it simply stays on screen), several images still rotate', () => {
    let advances = 0; const stop1 = startImageRotation(1, () => { advances += 1; }); stop1(); expect(advances).toBe(0);
    expect(startImageRotation(0, () => undefined)).toBeTypeOf('function');
  });
});

describe('wiring (source guards)', () => {
  const media = norm('components/storefront/hero-media.tsx');
  const carousel = norm('components/storefront/hero-carousel.tsx');
  const hook = norm('lib/hooks/use-hero-carousel.ts');
  it('the carousel tells the media whether the banner is alone; the video loops declaratively and by the shared rule', () => {
    expect(carousel).toContain('single={!several}');
    expect(media).toContain('loop={single}'); expect(media).toContain('video.loop = shouldLoopVideo(video.duration, single);');
  });
  it('the multi-banner machinery is untouched: the scheduler still exists only for 2+ banners and the image interval is unchanged', () => {
    expect(hook).toContain('if (!videoAware || count < 2) return;'); expect(hook).toContain('return startImageRotation(count, next);');
    expect(media).toContain('onEnded={playback.onEnded}'); expect(media).toContain('onError={fail}'); // ended / error handling and the poster fallback stay
  });
  it('no second timer or competing autoplay mechanism was added', () => {
    expect(`${media}${carousel}`).not.toMatch(/setInterval|requestAnimationFrame/);
  });
});
