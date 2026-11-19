/**
 * Full-screen product image viewer: zoom / pan maths. Pure (no React, no DOM), so every rule is unit-tested.
 *
 * The picture is drawn with `transform: translate(x, y) scale(s)` around its own centre. `x`/`y` are in screen pixels. Points are measured from the
 * CENTRE of the viewer stage (not its top-left), which keeps the formulas short.
 */
export type ZoomView = { scale: number; x: number; y: number };
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

/** The picture exactly as it first appears: as large as fits, centred, nothing cropped. */
export const FIT_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** What a click / double-tap zooms to. */
export const TAP_ZOOM_SCALE = 2.5;
/** Keyboard and button steps. */
export const ZOOM_STEP = 1.4;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const clampScale = (scale: number): number => (Number.isFinite(scale) ? clamp(scale, MIN_SCALE, MAX_SCALE) : MIN_SCALE);

/** Zoomed in beyond the fitted size (with a little tolerance for rounding). */
export const isZoomed = (view: ZoomView): boolean => view.scale > MIN_SCALE + 0.01;

/**
 * Keeps the picture from being dragged away: once it is larger than the stage, its edges may reach the stage's edges but never leave a gap; while it is
 * smaller than the stage (always at the fitted size) it stays centred. `fitted` is the picture's on-screen size at scale 1.
 */
export function clampView(view: ZoomView, fitted: Size, stage: Size): ZoomView {
  const scale = clampScale(view.scale);
  const maxX = Math.max(0, (fitted.w * scale - stage.w) / 2);
  const maxY = Math.max(0, (fitted.h * scale - stage.h) / 2);
  // + 0 turns a negative zero into a plain zero, so a fitted view always compares equal to FIT_VIEW.
  return { scale, x: clamp(Number.isFinite(view.x) ? view.x : 0, -maxX, maxX) + 0, y: clamp(Number.isFinite(view.y) ? view.y : 0, -maxY, maxY) + 0 };
}

/** Zoom to `nextScale` while keeping the spot under `point` (a cursor or a pinch centre) exactly where it is on screen. */
export function zoomAt(view: ZoomView, nextScale: number, point: Point, fitted: Size, stage: Size): ZoomView {
  const scale = clampScale(nextScale);
  const ratio = scale / view.scale;
  return clampView({ scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, fitted, stage);
}

/** A click or a double-tap: back to the fitted view when already zoomed, otherwise zoom in on the spot that was tapped. */
export function toggleZoom(view: ZoomView, point: Point, fitted: Size, stage: Size): ZoomView {
  return isZoomed(view) ? FIT_VIEW : zoomAt(view, TAP_ZOOM_SCALE, point, fitted, stage);
}

/** Buttons and keys: zoom about the stage centre (so the picture stays put). Zooming out to the fitted size resets the position. */
export function stepZoom(view: ZoomView, direction: 1 | -1, fitted: Size, stage: Size): ZoomView {
  const next = direction === 1 ? view.scale * ZOOM_STEP : view.scale / ZOOM_STEP;
  const result = zoomAt(view, next, { x: 0, y: 0 }, fitted, stage);
  return isZoomed(result) ? result : FIT_VIEW;
}

/** Mouse wheel / trackpad pinch (which browsers report as ctrl+wheel): a smooth exponential factor so one notch is a small, predictable step. */
export const wheelScale = (scale: number, deltaY: number, ctrlKey: boolean): number => clampScale(scale * Math.exp(-deltaY * (ctrlKey ? 0.01 : 0.0025)));

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Two-finger pinch: the scale follows how much the fingers moved apart, zoomed about where the gesture STARTED, and the picture also follows the
 * fingers' centre as it moves (so a pinch can pan at the same time).
 */
export function pinchView(start: { view: ZoomView; distance: number; mid: Point }, now: { distance: number; mid: Point }, fitted: Size, stage: Size): ZoomView {
  if (!(start.distance > 0)) return start.view;
  const zoomed = zoomAt(start.view, start.view.scale * (now.distance / start.distance), start.mid, fitted, stage);
  return clampView({ scale: zoomed.scale, x: zoomed.x + (now.mid.x - start.mid.x), y: zoomed.y + (now.mid.y - start.mid.y) }, fitted, stage);
}

/** Next / previous image index, wrapping at both ends. */
export const stepIndex = (index: number, count: number, delta: number): number => (count <= 0 ? 0 : (((index + delta) % count) + count) % count);

/** A touch counts as a tap (not a drag or swipe) when it barely moved and was quick. */
export const isTap = (moved: number, ms: number): boolean => moved < 8 && ms < 400;

/** Two taps close together in time and place = a double-tap. */
export const isDoubleTap = (previous: { at: number; point: Point } | null, now: { at: number; point: Point }): boolean =>
  previous !== null && now.at - previous.at < 320 && distance(previous.point, now.point) < 40;
