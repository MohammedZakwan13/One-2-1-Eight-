/**
 * Product detail gallery navigation. Pure (no React, no DOM), so every rule is unit-tested.
 *
 * ONE source of truth for the selected image: `GalleryState` (held once, by useProductGallery). The thumbnails, the previous / next arrows,
 * a swipe, the arrow keys, the mobile dots and the "01 / 03" counter all read the index from it and change it only through these functions.
 * The state remembers WHICH product it belongs to, so opening another product starts at the first image and can never show an image
 * index left over from the previous product.
 *
 * Swipe distance / direction / speed rules are the ones the homepage carousel already uses (lib/hero-nav.ts), reused as they are.
 */
import { arrowKeyStep, classifySwipe, wrapIndex } from '@/lib/hero-nav';

export type GalleryState = { id: string; index: number };

const clamp = (index: number, count: number) => (count < 1 ? 0 : Math.min(Math.max(Math.trunc(index) || 0, 0), count - 1));

/** The index to show now: 0 for a different product than the one the state was made for, and always inside the current image list. */
export const galleryIndex = (state: GalleryState, productId: string, count: number): number => (state.id === productId ? clamp(state.index, count) : 0);

/** Choose an image directly (a thumbnail or a dot). */
export const gallerySelect = (productId: string, count: number, index: number): GalleryState => ({ id: productId, index: clamp(index, count) });

/** Move by `delta` from wherever the gallery is NOW. Wraps: previous from the first image is the last, next from the last is the first. */
export const galleryGo = (state: GalleryState, productId: string, count: number, delta: number): GalleryState =>
  ({ id: productId, index: wrapIndex(galleryIndex(state, productId, count) + delta, count) });

/** "01 / 03" (two digits each, so a 10th, 11th or 12th image reads "10", not "010"). */
export const formatGalleryCounter = (index: number, count: number): { current: string; total: string } => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return { current: pad(index + 1), total: pad(count) };
};

/** Typing in a field must never be hijacked by the arrow keys. */
export const isTypingTarget = (target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean =>
  Boolean(target) && (['INPUT', 'TEXTAREA', 'SELECT'].includes(String(target?.tagName).toUpperCase()) || target?.isContentEditable === true);

/** -1 / +1 for ArrowLeft / ArrowRight pressed alone, outside form fields; 0 otherwise. */
export const galleryKeyDelta = (event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; target?: { tagName?: string; isContentEditable?: boolean } | null }): -1 | 0 | 1 => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) return 0;
  return arrowKeyStep(event.key);
};

/** +1 (next) for a swipe left, -1 (previous) for a swipe right, 0 when the movement is not a deliberate horizontal swipe. */
export const gallerySwipeDelta = (gesture: { dx: number; dy: number; ms: number }): -1 | 0 | 1 => {
  const direction = classifySwipe(gesture);
  return direction === 'next' ? 1 : direction === 'prev' ? -1 : 0;
};
