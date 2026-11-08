'use client';

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { galleryGo, galleryIndex, gallerySelect, gallerySwipeDelta, galleryKeyDelta, type GalleryState } from '@/lib/gallery-nav';

/**
 * The product gallery's single selected-image state (rules in lib/gallery-nav.ts).
 * `go` uses a functional update, so quick repeated presses (or a swipe right after a tap) always build on the latest image instead of a stale one.
 */
export function useProductGallery(productId: string, count: number) {
  const [state, setState] = useState<GalleryState>({ id: productId, index: 0 });
  // A different product (the route changed but this component is reused): start again at the first image, even if the visitor later comes back to the earlier product.
  if (state.id !== productId) setState({ id: productId, index: 0 });
  const index = galleryIndex(state, productId, count);
  const swipe = useRef<{ id: number; x: number; y: number; at: number } | null>(null);

  const select = useCallback((target: number) => setState(gallerySelect(productId, count, target)), [productId, count]);
  const go = useCallback((delta: number) => { if (count > 1) setState(current => galleryGo(current, productId, count, delta)); }, [productId, count]);

  /** For the main image: a swipe with a finger or a pen. The element has `touch-action: pan-y`, so vertical scrolling stays with the browser. */
  const mainProps = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      // A mouse never swipes; a touch that starts on a button (the heart, the arrows) belongs to that button.
      if (count < 2 || event.pointerType === 'mouse' || (event.target as HTMLElement).closest('button')) { swipe.current = null; return; }
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const start = swipe.current;
      swipe.current = null;
      if (!start || start.id !== event.pointerId) return;
      const delta = gallerySwipeDelta({ dx: event.clientX - start.x, dy: event.clientY - start.y, ms: event.timeStamp - start.at });
      if (delta) go(delta);
    },
    onPointerCancel: () => { swipe.current = null; }, // the browser took the gesture over (a vertical scroll)
  };

  /** For the whole gallery: Left / Right arrow keys while focus is inside it (never while typing in a field). */
  const sectionProps = {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const delta = galleryKeyDelta({ key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, target: event.target as HTMLElement });
      if (!delta || count < 2) return;
      event.preventDefault();
      go(delta);
    },
  };

  return { index, count, select, go, mainProps, sectionProps };
}
