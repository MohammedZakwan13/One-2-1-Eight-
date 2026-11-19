/**
 * Manual navigation for the hero carousel. Pure (no React, no DOM), so every rule is unit-tested. It decides WHERE to go; the timing rules
 * (lib/hero-timing.ts) and the pause rules (lib/hero-pause.ts) are not touched by anything here.
 */

/** A swipe must travel at least this far sideways. Anything shorter is an accidental touch or a tap and is ignored. */
export const SWIPE_MIN_DISTANCE_PX = 48;
/** ...and be clearly horizontal: sideways travel at least this many times the vertical travel, so a scroll that drifts is never a swipe. */
export const SWIPE_AXIS_RATIO = 1.5;
/** ...and be a gesture, not a slow drag: a touch held longer than this is not treated as a swipe. */
export const SWIPE_MAX_DURATION_MS = 1200;

/** Swipe left = next banner, swipe right = previous banner. `null` = not a swipe. */
export function classifySwipe({ dx, dy, ms }: { dx: number; dy: number; ms: number }): 'next' | 'prev' | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(ms)) return null;
  if (ms < 0 || ms > SWIPE_MAX_DURATION_MS) return null;
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX) return null;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return null;
  return dx < 0 ? 'next' : 'prev';
}

/** Index arithmetic that wraps both ways (the carousel is circular, as the automatic rotation already is). */
export const wrapIndex = (index: number, count: number): number => (count <= 0 ? 0 : ((index % count) + count) % count);

/** ArrowLeft = previous, ArrowRight = next, anything else = 0 (not a navigation key). */
export const arrowKeyStep = (key: string): -1 | 0 | 1 => (key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0);

/** Most indicator segments shown at once. A phone has less room, and a long row of tiny dots would be unusable there. */
export const indicatorMax = (isMobile: boolean | null): number => (isMobile ? 5 : 7);

/**
 * Which banners get an indicator: all of them when they fit, otherwise a window of `max` kept around the active one (so 10, 12 or 30
 * banners never produce a long row). Returns a half-open range [start, end).
 */
export function indicatorWindow(count: number, active: number, max: number): { start: number; end: number } {
  if (count <= max) return { start: 0, end: Math.max(count, 0) };
  const start = Math.min(Math.max(active - Math.floor(max / 2), 0), count - max);
  return { start, end: start + max };
}

/** "03 / 12": shown only when the indicators cannot show every banner, so the visitor still knows where they are. */
export const formatCounter = (active: number, count: number): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(active + 1)} / ${pad(count)}`;
};
