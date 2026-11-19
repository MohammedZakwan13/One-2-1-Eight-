/**
 * Hero carousel timing. Pure (no React, no DOM): the timers are plain setTimeout / setInterval so tests can drive them with fake timers.
 *
 * IMAGE-ONLY carousels keep the original behaviour exactly: one `setInterval` at IMAGE_SLIDE_MS (5.4 s) that is never reset by a slide
 * change (`startImageRotation`, used by the original code path). Only when some banner is a video does the video-aware scheduler take
 * over; inside it an image slide still lasts IMAGE_SLIDE_MS.
 *
 * Video rules (each measured from real HTMLVideoElement events, never estimated from file size):
 *   shorter than 6 s   loops; the slide stays at least MIN_VIDEO_SLIDE_MS, then advances (the countdown is never restarted by the loop)
 *   6 s or longer      plays once, to the end, and advances on `ended`; a clip is never cut short (10 s is advice, not a limit)
 *   no/unknown length, a video that errors, is blocked, or never starts: shows the poster and advances after MIN_VIDEO_SLIDE_MS
 * A watchdog (clip length + VIDEO_STALL_GRACE_MS) means a stalled download can never hold the carousel forever.
 */
import { resolveHeroMedia, type HeroMediaFields } from '@/lib/hero-media';

export const IMAGE_SLIDE_MS = 5400;
export const MIN_VIDEO_SLIDE_MS = 6000;
export const RECOMMENDED_VIDEO_MIN_SECONDS = 6;
export const RECOMMENDED_VIDEO_MAX_SECONDS = 10;
/**
 * Slack above the recommended maximum before the admin is advised to trim. A browser's own player shows whole seconds (a 10.03 s clip reads
 * "0:10"), and an editor's "10 second" export is rarely exactly 10.000 s, so the advice starts above 10.5 s. This is advice only: it never
 * blocks an upload, and the carousel's timing always uses the video's real duration, not this number.
 */
export const RECOMMENDED_VIDEO_TOLERANCE_SECONDS = 0.5;
/** A 6 s+ clip that has not started playing this long after its length is known is treated as failed (poster + fallback timing). */
export const VIDEO_START_TIMEOUT_MS = 5000;
/** Extra time beyond a clip's own length before a stalled playback is given up on. */
export const VIDEO_STALL_GRACE_MS = 4000;

export const VIDEO_DURATION_TIP = 'Recommended hero video duration: 6–10 seconds.';
export const VIDEO_TOO_LONG_NOTE = 'This video is longer than recommended for an automatic hero carousel. Consider trimming it to 6–10 seconds for a better browsing experience.';

/** The non-blocking note for the admin uploader: only above 10.5 s (10 s plus the tolerance); null when the length is fine or unknown. */
export const videoDurationAdvice = (seconds: number | null | undefined): string | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > RECOMMENDED_VIDEO_MAX_SECONDS + RECOMMENDED_VIDEO_TOLERANCE_SECONDS ? VIDEO_TOO_LONG_NOTE : null;

/** The real length from the browser, to two decimals (e.g. "10.03 s"), so what the admin sees matches what the scheduler uses. */
export const formatVideoDuration = (seconds: number): string => `${seconds.toFixed(2)} s`;

export type SlideKind = 'image' | 'video';
export type HeroEnvironment = { isMobile: boolean | null; reducedMotion: boolean | null };

/** True when any active banner has a video on either device. Based on the data only, so it does not change when the window is resized. */
export const hasVideoSlides = (slides: HeroMediaFields[]): boolean => slides.some(slide => slide.desktopMediaType === 'video' || slide.mobileMediaType === 'video');

/**
 * How long the given slide is shown, for THIS visitor. A video counts only when it will really be shown as a video: the device is known,
 * the visitor has not asked for reduced motion, and the resolved media for that device is a video. Everything else is a still image.
 */
export function slideKind(slide: HeroMediaFields, env: HeroEnvironment): SlideKind {
  if (env.isMobile === null || env.reducedMotion !== false) return 'image';
  const media = resolveHeroMedia(slide, env.isMobile ? 'mobile' : 'desktop');
  return media.type === 'video' && media.video ? 'video' : 'image';
}

/**
 * Whether a banner video should loop by itself. A lone banner has no next slide to hand over to, so nothing would ever advance after the video ends and
 * it would freeze on its last frame: it always loops. With several banners the rules above are unchanged (shorter than 6 s loops; 6 s or longer plays
 * once and the carousel advances on `ended`).
 */
export function shouldLoopVideo(durationSeconds: number, singleBanner: boolean): boolean {
  return singleBanner || !(Number.isFinite(durationSeconds) && durationSeconds * 1000 >= MIN_VIDEO_SLIDE_MS);
}

/** The ORIGINAL automatic rotation, unchanged: one interval, IMAGE_SLIDE_MS, never reset by a slide change. Returns its cleanup. */
export function startImageRotation(slideCount: number, advance: () => void): () => void {
  if (slideCount < 2) return () => undefined;
  const id = setInterval(advance, IMAGE_SLIDE_MS);
  return () => clearInterval(id);
}

export type SlideScheduler = {
  /** A new slide became current. Cancels everything the previous slide had pending. */
  activate: (kind: SlideKind) => void;
  videoMetadata: (durationSeconds: number) => void;
  videoPlaying: () => void;
  videoEnded: () => void;
  /** The video errored, was blocked from playing, or otherwise cannot be shown. */
  videoFailed: () => void;
  /** The video file changed under the same slide (the visitor crossed the phone/desktop breakpoint). */
  videoSourceChanged: () => void;
  setPaused: (paused: boolean) => void;
  dispose: () => void;
};

/**
 * Decides when the current slide is over. Exactly one slide is current and exactly one decision is pending at a time: every event
 * re-arms from scratch, and a generation counter makes any callback from an earlier arming a no-op, so timers can never overlap.
 */
export function createSlideScheduler(advance: () => void, clock: { now: () => number } = { now: () => Date.now() }): SlideScheduler {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let generation = 0;
  let kind: SlideKind | null = null;
  let duration: number | null = null;
  let playing = false;
  let failed = false;
  let paused = false;
  let advanced = false;
  let endedWhilePaused = false;
  let shownAt = 0;

  const clearTimers = () => { for (const id of timers) clearTimeout(id); timers.clear(); generation += 1; };
  const after = (ms: number, then: () => void) => {
    const mine = generation;
    const id = setTimeout(() => { timers.delete(id); if (mine === generation) then(); }, Math.max(0, ms));
    timers.add(id);
  };
  const go = () => { if (kind === null || advanced) return; advanced = true; clearTimers(); advance(); };
  const remainingMinimum = () => Math.max(0, MIN_VIDEO_SLIDE_MS - (clock.now() - shownAt));

  const arm = () => {
    clearTimers();
    if (kind === null || paused || advanced) return;
    if (kind === 'image') { after(IMAGE_SLIDE_MS, go); return; }
    if (failed || duration === null || duration * 1000 < MIN_VIDEO_SLIDE_MS) { after(remainingMinimum(), go); return; }
    // 6 s or longer: play to the end. The timers below are only safety nets.
    if (!playing) { after(VIDEO_START_TIMEOUT_MS, () => { failed = true; arm(); }); return; }
    after(duration * 1000 + VIDEO_STALL_GRACE_MS, go);
  };

  return {
    activate: next => { kind = next; duration = null; playing = false; failed = false; advanced = false; endedWhilePaused = false; shownAt = clock.now(); arm(); },
    videoMetadata: seconds => { if (kind !== 'video') return; duration = Number.isFinite(seconds) && seconds > 0 ? seconds : null; arm(); },
    videoPlaying: () => { if (kind !== 'video') return; playing = true; arm(); },
    videoEnded: () => {
      if (kind !== 'video' || failed) return;
      if (paused) { endedWhilePaused = true; return; }
      if (duration !== null && duration * 1000 >= MIN_VIDEO_SLIDE_MS) go(); // a looping short clip never ends; anything else keeps its minimum
    },
    videoFailed: () => { if (kind !== 'video') return; failed = true; arm(); },
    videoSourceChanged: () => { if (kind !== 'video') return; duration = null; playing = false; failed = false; arm(); },
    setPaused: next => {
      if (next === paused) return;
      paused = next;
      if (paused) { clearTimers(); return; }
      shownAt = clock.now(); // resuming gives the slide its normal time again
      if (endedWhilePaused) { endedWhilePaused = false; go(); return; }
      arm();
    },
    dispose: () => { kind = null; clearTimers(); },
  };
}
