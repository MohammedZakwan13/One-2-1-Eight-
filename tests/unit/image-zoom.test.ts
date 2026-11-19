import { describe, expect, it } from 'vitest';
import { FIT_VIEW, MAX_SCALE, TAP_ZOOM_SCALE, clampScale, clampView, distance, isDoubleTap, isTap, isZoomed, midpoint, pinchView, stepIndex, stepZoom, toggleZoom, wheelScale, zoomAt } from '@/lib/image-zoom';

const stage = { w: 1000, h: 800 };
const fitted = { w: 533, h: 800 }; // a 2:3 portrait picture fitted into the stage by height

describe('scale limits', () => {
  it('never goes below the fitted size or above the maximum, and ignores garbage', () => {
    expect(clampScale(0.2)).toBe(1);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(isZoomed(FIT_VIEW)).toBe(false);
    expect(isZoomed({ scale: 1.005, x: 0, y: 0 })).toBe(false);
    expect(isZoomed({ scale: 1.5, x: 0, y: 0 })).toBe(true);
  });
});

describe('clampView (panning stays inside the picture)', () => {
  it('keeps the picture centred while it is smaller than the stage', () => {
    expect(clampView({ scale: 1, x: 200, y: -50 }, fitted, stage)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampView({ scale: 1.5, x: 500, y: 0 }, fitted, stage)).toEqual({ scale: 1.5, x: 0, y: 0 }); // 533 * 1.5 = 800 < 1000: still narrower than the stage
  });
  it('lets the picture edge reach the stage edge but never leaves a gap', () => {
    const view = clampView({ scale: 3, x: 5000, y: -5000 }, fitted, stage);
    expect(view.x).toBeCloseTo((533 * 3 - 1000) / 2); // 299.5
    expect(view.y).toBeCloseTo(-((800 * 3 - 800) / 2)); // -800
  });
  it('repairs non-finite positions', () => {
    expect(clampView({ scale: 2, x: Number.NaN, y: Infinity }, fitted, stage).x).toBe(0);
  });
});

describe('zoomAt (the spot under the cursor stays put)', () => {
  it('keeps the point fixed on screen', () => {
    const point = { x: 120, y: -80 };
    const start = { scale: 1, x: 0, y: 0 };
    const zoomed = zoomAt(start, 2, point, { w: 1000, h: 800 }, stage); // a picture as big as the stage, so no clamping interferes
    // the picture-local coordinate under the point before and after must match: (p - t) / s
    expect((point.x - zoomed.x) / zoomed.scale).toBeCloseTo((point.x - start.x) / start.scale);
    expect((point.y - zoomed.y) / zoomed.scale).toBeCloseTo((point.y - start.y) / start.scale);
  });
  it('returns to the exact fitted view when zoomed back out to 1', () => {
    const zoomed = zoomAt({ scale: 1, x: 0, y: 0 }, 3, { x: 200, y: 100 }, fitted, stage);
    expect(zoomAt(zoomed, 1, { x: 200, y: 100 }, fitted, stage)).toEqual(FIT_VIEW);
  });
});

describe('click / double-tap / buttons', () => {
  it('toggles between fitted and the tap zoom', () => {
    const zoomed = toggleZoom(FIT_VIEW, { x: 0, y: 0 }, fitted, stage);
    expect(zoomed.scale).toBe(TAP_ZOOM_SCALE);
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, fitted, stage)).toEqual(FIT_VIEW);
  });
  it('zoom buttons step about the centre, stop at the limits, and zooming out fully resets', () => {
    let view = FIT_VIEW;
    for (let i = 0; i < 20; i++) view = stepZoom(view, 1, fitted, stage);
    expect(view.scale).toBe(MAX_SCALE);
    for (let i = 0; i < 20; i++) view = stepZoom(view, -1, fitted, stage);
    expect(view).toEqual(FIT_VIEW);
  });
  it('a quick, barely-moving touch is a tap; a drag or a long press is not', () => {
    expect(isTap(2, 120)).toBe(true);
    expect(isTap(20, 120)).toBe(false);
    expect(isTap(2, 900)).toBe(false);
  });
  it('double-tap = two taps close together in time and place', () => {
    const first = { at: 1000, point: { x: 100, y: 100 } };
    expect(isDoubleTap(null, first)).toBe(false);
    expect(isDoubleTap(first, { at: 1200, point: { x: 110, y: 105 } })).toBe(true);
    expect(isDoubleTap(first, { at: 1500, point: { x: 100, y: 100 } })).toBe(false); // too slow
    expect(isDoubleTap(first, { at: 1200, point: { x: 400, y: 100 } })).toBe(false); // too far apart
  });
});

describe('wheel and pinch', () => {
  it('wheel up zooms in, wheel down zooms out, within limits; pinch-wheel (ctrl) is more sensitive', () => {
    expect(wheelScale(1, -100, false)).toBeGreaterThan(1);
    expect(wheelScale(2, 100, false)).toBeLessThan(2);
    expect(wheelScale(1, 500, false)).toBe(1);
    expect(wheelScale(MAX_SCALE, -500, false)).toBe(MAX_SCALE);
    expect(wheelScale(1, -10, true)).toBeGreaterThan(wheelScale(1, -10, false));
  });
  it('a pinch scales by the finger distance ratio and follows the centre', () => {
    const a = { x: -50, y: 0 }; const b = { x: 50, y: 0 };
    const start = { view: FIT_VIEW, distance: distance(a, b), mid: midpoint(a, b) };
    const wide = { w: 1000, h: 800 };
    const spread = pinchView(start, { distance: 200, mid: { x: 0, y: 0 } }, wide, stage);
    expect(spread.scale).toBeCloseTo(2);
    const dragged = pinchView(start, { distance: 200, mid: { x: 30, y: 10 } }, wide, stage);
    expect(dragged.x).toBeCloseTo(spread.x + 30);
    expect(pinchView({ ...start, distance: 0 }, { distance: 50, mid: { x: 0, y: 0 } }, wide, stage)).toEqual(FIT_VIEW);
  });
});

describe('image index', () => {
  it('wraps both ways and survives an empty list', () => {
    expect(stepIndex(0, 4, -1)).toBe(3);
    expect(stepIndex(3, 4, 1)).toBe(0);
    expect(stepIndex(1, 4, 1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});
