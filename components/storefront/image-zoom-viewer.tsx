'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { gallerySwipeDelta } from '@/lib/gallery-nav';
import {
  FIT_VIEW, clampView, distance, isDoubleTap, isTap, isZoomed, midpoint, pinchView, stepIndex, stepZoom, toggleZoom, wheelScale, zoomAt,
  type Point, type Size, type ZoomView,
} from '@/lib/image-zoom';

type Props = {
  images: string[];
  /** The selected image. Owned by the product gallery, so the viewer and the gallery behind it always show the same one. */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  productName: string;
};

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen product image viewer. The picture opens fitted (as large as fits, nothing cropped) and is the same full-resolution file the gallery uses.
 * Desktop: click to zoom in / out, mouse wheel or trackpad pinch to zoom, drag to pan, +/- keys and buttons. Touch: pinch, double-tap, drag to pan, and
 * swipe sideways (while not zoomed) for the next / previous picture. Thumbnails switch pictures; Escape or the close button leaves. While open, the page
 * behind cannot scroll, focus stays inside, and focus returns to what opened it.
 */
export function ImageZoomViewer({ images, index, onIndexChange, onClose, productName }: Props) {
  const count = images.length;
  const [view, setView] = useState<ZoomView>(FIT_VIEW);
  const [dragging, setDragging] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; at: number; origin: ZoomView; moved: number; pinch: { view: ZoomView; distance: number; mid: Point } | null; wasPinch: boolean; touch: boolean } | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);

  const apply = useCallback((next: ZoomView) => { viewRef.current = next; setView(next); }, []);

  /** Sizes needed by the maths: the stage, and the picture as it is on screen at scale 1 (its current box divided by the current scale). */
  const measure = useCallback((): { fitted: Size; box: Size; centre: Point } | null => {
    const stageEl = stage.current; const imageEl = image.current;
    if (!stageEl || !imageEl) return null;
    const stageRect = stageEl.getBoundingClientRect(); const imageRect = imageEl.getBoundingClientRect();
    const scale = viewRef.current.scale || 1;
    return { fitted: { w: imageRect.width / scale, h: imageRect.height / scale }, box: { w: stageRect.width, h: stageRect.height }, centre: { x: stageRect.left + stageRect.width / 2, y: stageRect.top + stageRect.height / 2 } };
  }, []);

  const go = useCallback((delta: number) => { if (count > 1) onIndexChange(stepIndex(index, count, delta)); }, [count, index, onIndexChange]);
  const zoomBy = useCallback((direction: 1 | -1) => { const m = measure(); if (m) apply(stepZoom(viewRef.current, direction, m.fitted, m.box)); }, [apply, measure]);
  const reset = useCallback(() => apply(FIT_VIEW), [apply]);

  // A new picture always starts fitted.
  useEffect(() => { apply(FIT_VIEW); }, [index, apply]);

  // The page behind must not scroll while the viewer is open; focus moves in, and returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; opener?.focus?.(); };
  }, []);

  // Wheel / trackpad pinch must be a non-passive listener to stop the page from zooming or scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const m = measure();
      if (!m) return;
      const current = viewRef.current;
      const next = wheelScale(current.scale, event.deltaY, event.ctrlKey);
      if (next === current.scale) return;
      const result = zoomAt(current, next, { x: event.clientX - m.centre.x, y: event.clientY - m.centre.y }, m.fitted, m.box);
      apply(isZoomed(result) ? result : FIT_VIEW);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [apply, measure]);

  // Keyboard: handled on the document while the viewer is open, so it works wherever focus happens to be (a click on the picture leaves focus on the page body).
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'Tab') { // keep focus inside the viewer
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      const active = document.activeElement;
      if (!dialog.current?.contains(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(-1); }
    else if (event.key === '0') { event.preventDefault(); reset(); }
  };
  const keyHandler = useRef(handleKey);
  keyHandler.current = handleKey;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stage.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const m = measure();
    if (pointers.current.size === 2 && m) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { start: a, at: event.timeStamp, origin: viewRef.current, moved: 0, wasPinch: true, touch: true,
        pinch: { view: viewRef.current, distance: distance(a, b), mid: { x: midpoint(a, b).x - m.centre.x, y: midpoint(a, b).y - m.centre.y } } };
      setDragging(true);
    } else if (pointers.current.size === 1) {
      gesture.current = { start: { x: event.clientX, y: event.clientY }, at: event.timeStamp, origin: viewRef.current, moved: 0, pinch: null, wasPinch: false, touch: event.pointerType !== 'mouse' };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current; const m = measure();
    if (!g || !m) return;
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = midpoint(a, b);
      const next = pinchView(g.pinch, { distance: distance(a, b), mid: { x: mid.x - m.centre.x, y: mid.y - m.centre.y } }, m.fitted, m.box);
      apply(isZoomed(next) ? next : FIT_VIEW);
      return;
    }
    if (pointers.current.size !== 1) return;
    const dx = event.clientX - g.start.x; const dy = event.clientY - g.start.y;
    g.moved = Math.max(g.moved, Math.hypot(dx, dy));
    if (isZoomed(g.origin) && g.moved > 3) { // dragging a zoomed picture pans it
      setDragging(true);
      apply(clampView({ scale: g.origin.scale, x: g.origin.x + dx, y: g.origin.y + dy }, m.fitted, m.box));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) { if (g) g.pinch = null; return; } // one finger left after a pinch: ignore the rest of that gesture
    setDragging(false);
    gesture.current = null;
    if (!g || g.wasPinch) return; // the end of a pinch is never a tap or a swipe
    const m = measure();
    if (!m) return;
    const point = { x: event.clientX - m.centre.x, y: event.clientY - m.centre.y };
    const ms = event.timeStamp - g.at;
    if (isTap(g.moved, ms)) {
      if (!g.touch) { apply(toggleZoom(viewRef.current, point, m.fitted, m.box)); return; } // a mouse click zooms straight away
      const now = { at: event.timeStamp, point: { x: event.clientX, y: event.clientY } };
      if (isDoubleTap(lastTap.current, now)) { lastTap.current = null; apply(toggleZoom(viewRef.current, point, m.fitted, m.box)); }
      else lastTap.current = now;
      return;
    }
    // A sideways swipe moves to the next / previous picture, only while the picture is not zoomed (otherwise the drag was a pan).
    if (g.touch && !isZoomed(viewRef.current)) {
      const delta = gallerySwipeDelta({ dx: event.clientX - g.start.x, dy: event.clientY - g.start.y, ms });
      if (delta) go(delta);
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => { pointers.current.delete(event.pointerId); if (!pointers.current.size) { gesture.current = null; setDragging(false); } };

  const zoomed = isZoomed(view);
  const label = `${productName} image ${index + 1} of ${count}`;

  return createPortal(
    <div ref={dialog} className="zoom-viewer" role="dialog" aria-modal="true" aria-label={`${productName} images`} tabIndex={-1}>
      {count > 1 && <div className="zoom-thumbs" role="group" aria-label="Product images">
        {images.map((src, i) => <button key={`${src}-${i}`} type="button" className={i === index ? 'active' : ''} onClick={() => onIndexChange(i)} aria-label={`View image ${i + 1}`} aria-current={i === index ? 'true' : undefined}>
          <img src={src} alt="" loading="lazy" draggable={false} />
        </button>)}
      </div>}
      <div className="zoom-main">
        <div
          ref={stage}
          className={`zoom-stage ${zoomed ? 'is-zoomed' : ''} ${dragging ? 'is-dragging' : ''}`}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        >
          <img
            ref={image} className="zoom-image" src={images[index]} alt={label} draggable={false} decoding="async"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        </div>
        <span className="zoom-counter" aria-hidden="true">{String(index + 1).padStart(2, '0')} <i>/</i> {String(count).padStart(2, '0')}</span>
        <button ref={closeButton} type="button" className="zoom-close" onClick={onClose} aria-label="Close full-screen view"><X size={22} aria-hidden="true" /></button>
        {count > 1 && <>
          <button type="button" className="zoom-arrow zoom-arrow-prev" onClick={() => go(-1)} aria-label="Previous image"><ChevronLeft size={22} aria-hidden="true" /></button>
          <button type="button" className="zoom-arrow zoom-arrow-next" onClick={() => go(1)} aria-label="Next image"><ChevronRight size={22} aria-hidden="true" /></button>
        </>}
        <div className="zoom-toolbar" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(-1)} disabled={!zoomed} aria-label="Zoom out"><ZoomOut size={19} aria-hidden="true" /></button>
          <button type="button" onClick={reset} disabled={!zoomed} aria-label="Reset zoom to fit"><RotateCcw size={17} aria-hidden="true" /></button>
          <button type="button" onClick={() => zoomBy(1)} disabled={view.scale >= 3.99} aria-label="Zoom in"><ZoomIn size={19} aria-hidden="true" /></button>
        </div>
        <span className="visually-hidden" role="status" aria-live="polite">{zoomed ? `Zoomed to ${Math.round(view.scale * 100)} percent` : 'Fit to screen'}</span>
      </div>
    </div>,
    document.body,
  );
}
