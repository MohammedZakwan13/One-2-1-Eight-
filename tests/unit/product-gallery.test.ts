import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatGalleryCounter, galleryGo, galleryIndex, galleryKeyDelta, gallerySelect, gallerySwipeDelta, isTypingTarget, type GalleryState,
} from '@/lib/gallery-nav';

/** The gallery as the hook runs it: one state, changed only through the pure functions. */
function gallery(productId: string, count: number) {
  let state: GalleryState = { id: productId, index: 0 };
  return {
    go: (delta: number) => { if (count > 1) state = galleryGo(state, productId, count, delta); },
    select: (index: number) => { state = gallerySelect(productId, count, index); },
    get index() { return galleryIndex(state, productId, count); },
    get counter() { const c = formatGalleryCounter(galleryIndex(state, productId, count), count); return `${c.current} / ${c.total}`; },
    /** Which thumbnail is "active": the same index the main image and counter use. */
    get activeThumbnail() { return galleryIndex(state, productId, count); },
    state: () => state,
  };
}

describe('previous / next arrows', () => {
  it('Next moves to the next image and Previous to the one before', () => {
    const g = gallery('p', 3);
    g.go(1); expect(g.index).toBe(1);
    g.go(1); expect(g.index).toBe(2);
    g.go(-1); expect(g.index).toBe(1);
  });
  it('the counter follows: 01 / 03 → Next → 02 / 03 → Next → 03 / 03', () => {
    const g = gallery('p', 3);
    expect(g.counter).toBe('01 / 03');
    g.go(1); expect(g.counter).toBe('02 / 03');
    g.go(1); expect(g.counter).toBe('03 / 03');
  });
  it('wraps: Previous from the first image is the last, Next from the last is the first', () => {
    const g = gallery('p', 3);
    g.go(-1); expect(g.index).toBe(2); expect(g.counter).toBe('03 / 03');
    g.go(1); expect(g.index).toBe(0); expect(g.counter).toBe('01 / 03');
  });
  it('quick repeated presses always build on the latest image (no stale index)', () => {
    const g = gallery('p', 5);
    for (let i = 0; i < 7; i += 1) g.go(1);
    expect(g.index).toBe(7 % 5);
    for (let i = 0; i < 12; i += 1) g.go(-1);
    expect(g.index).toBe(((7 - 12) % 5 + 5) % 5);
  });
});

describe('thumbnails, counter and active state share one source of truth', () => {
  it('clicking the second thumbnail shows image 2 and the counter reads 02 / 03', () => {
    const g = gallery('p', 3);
    g.select(1);
    expect(g.index).toBe(1);
    expect(g.counter).toBe('02 / 03');
  });
  it('arrow navigation moves the active thumbnail, and the arrows continue from a thumbnail choice', () => {
    const g = gallery('p', 4);
    g.go(1); g.go(1);
    expect(g.activeThumbnail).toBe(2);
    g.select(0);
    g.go(1);
    expect(g.activeThumbnail).toBe(1);
    expect(g.counter).toBe('02 / 04');
  });
  it('a thumbnail index outside the list is clamped, never shows a missing image', () => {
    const g = gallery('p', 3);
    g.select(99); expect(g.index).toBe(2);
    g.select(-4); expect(g.index).toBe(0);
  });
  it('the page uses one state only: thumbnails, dots, counter and main image all read gallery.index', () => {
    const page = readFileSync('components/storefront/pages/product-detail-page.tsx', 'utf8');
    expect(page).toContain('const gallery = useProductGallery(product.id, galleryImages.length);');
    expect(page).toContain('const activeImage = gallery.index;');
    expect(page).not.toMatch(/setActiveImage|useState\(0\)/); // no second copy of the selected index
    expect(page).toContain("className={activeImage === index ? 'active' : ''} onClick={() => gallery.select(index)}");
    expect(page).toContain("onClick={() => gallery.select(idx)}");
    expect(page).toContain('const currentImage = galleryImages[activeImage] || \'\';');
    expect(page).toContain('{counter.current} <i>/</i> {counter.total}');
  });
});

describe('different numbers of images', () => {
  it('one image: nothing to navigate, no controls (the arrows are rendered only for 2 or more images)', () => {
    const g = gallery('p', 1);
    g.go(1); g.go(-1); expect(g.index).toBe(0);
    const page = readFileSync('components/storefront/pages/product-detail-page.tsx', 'utf8');
    expect(page.match(/\{hasMultipleImages && <button type="button" className="gallery-arrow/g)).toHaveLength(2);
    expect(page).toContain('const hasMultipleImages = galleryImages.length > 1;');
    expect(page).toContain("hasMultipleImages ? 'has-thumbnails' : 'single-image'"); // the single-image layout is unchanged
    expect(gallerySwipeDelta({ dx: -200, dy: 0, ms: 150 })).toBe(1); // (the swipe handler itself returns early when count < 2: see the hook check below)
    expect(readFileSync('lib/hooks/use-product-gallery.ts', 'utf8')).toContain('if (count < 2 || event.pointerType === \'mouse\'');
  });
  it('two images: Next and Previous both flip between them', () => {
    const g = gallery('p', 2);
    g.go(1); expect(g.counter).toBe('02 / 02');
    g.go(1); expect(g.counter).toBe('01 / 02');
    g.go(-1); expect(g.counter).toBe('02 / 02');
  });
  it('more than three images: a full cycle visits each image once and returns to the start (5 and 12 images)', () => {
    for (const count of [4, 5, 12]) {
      const g = gallery('p', count);
      const seen: number[] = [g.index];
      for (let i = 0; i < count; i += 1) { g.go(1); seen.push(g.index); }
      expect(seen).toEqual([...Array.from({ length: count }, (_, i) => i), 0]);
    }
  });
  it('ten or more images keep a two-digit counter ("10 / 12", never "010")', () => {
    expect(formatGalleryCounter(9, 12)).toEqual({ current: '10', total: '12' });
    expect(formatGalleryCounter(11, 12)).toEqual({ current: '12', total: '12' });
    expect(formatGalleryCounter(0, 3)).toEqual({ current: '01', total: '03' }); // the existing look for ordinary products
  });
});

describe('swipe', () => {
  it('swipe left shows the next image, swipe right the previous one', () => {
    expect(gallerySwipeDelta({ dx: -120, dy: 8, ms: 220 })).toBe(1);
    expect(gallerySwipeDelta({ dx: 120, dy: -8, ms: 220 })).toBe(-1);
  });
  it('small accidental movements and taps are ignored', () => {
    expect(gallerySwipeDelta({ dx: 0, dy: 0, ms: 90 })).toBe(0);
    expect(gallerySwipeDelta({ dx: -47, dy: 0, ms: 100 })).toBe(0);
    expect(gallerySwipeDelta({ dx: 30, dy: 5, ms: 100 })).toBe(0);
  });
  it('a vertical scroll, even a drifting one, never changes the image', () => {
    expect(gallerySwipeDelta({ dx: -60, dy: 90, ms: 250 })).toBe(0);
    expect(gallerySwipeDelta({ dx: -50, dy: 400, ms: 400 })).toBe(0);
    expect(gallerySwipeDelta({ dx: -60, dy: 60, ms: 200 })).toBe(0);
  });
  it('a slow drag is not a swipe', () => {
    expect(gallerySwipeDelta({ dx: -150, dy: 0, ms: 5000 })).toBe(0);
  });
  it('page scrolling is left to the browser: the image area is touch-action: pan-y and the swipe handlers never call preventDefault', () => {
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toMatch(/\.gallery-main \{\s*touch-action: pan-y;/);
    const hook = readFileSync('lib/hooks/use-product-gallery.ts', 'utf8');
    const mainProps = hook.slice(hook.indexOf('const mainProps'), hook.indexOf('const sectionProps'));
    expect(mainProps).not.toContain('preventDefault');
    expect(mainProps).toContain('onPointerCancel'); // a browser-taken scroll cancels the gesture
    expect(mainProps).toContain("event.pointerType === 'mouse'");
    expect(mainProps).toContain("closest('button')"); // a touch on the heart or an arrow is never a swipe
  });
});

describe('keyboard', () => {
  it('Left / Right arrows navigate, other keys and modified keys do not', () => {
    expect(galleryKeyDelta({ key: 'ArrowRight' })).toBe(1);
    expect(galleryKeyDelta({ key: 'ArrowLeft' })).toBe(-1);
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'Home', 'a']) expect(galleryKeyDelta({ key })).toBe(0);
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) expect(galleryKeyDelta({ key: 'ArrowRight', [mod]: true })).toBe(0);
  });
  it('typing in a form field is never hijacked', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) expect(galleryKeyDelta({ key: 'ArrowRight', target: { tagName } })).toBe(0);
    expect(galleryKeyDelta({ key: 'ArrowRight', target: { tagName: 'DIV', isContentEditable: true } })).toBe(0);
    expect(galleryKeyDelta({ key: 'ArrowRight', target: { tagName: 'BUTTON' } })).toBe(1);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('product / variant changes never show a stale image', () => {
  it('a different product starts at the first image, whatever the previous product had selected', () => {
    const state = gallerySelect('product-a', 5, 3);
    expect(galleryIndex(state, 'product-a', 5)).toBe(3);
    expect(galleryIndex(state, 'product-b', 2)).toBe(0);
  });
  it('if the image list gets shorter, the index is pulled back inside it', () => {
    const state = gallerySelect('p', 6, 5);
    expect(galleryIndex(state, 'p', 3)).toBe(2);
    expect(galleryIndex(state, 'p', 0)).toBe(0);
  });
  it('the hook resets its state when the product changes (also when the visitor later returns to the first product)', () => {
    const hook = readFileSync('lib/hooks/use-product-gallery.ts', 'utf8');
    expect(hook).toContain("if (state.id !== productId) setState({ id: productId, index: 0 });");
    expect(hook).toContain('setState(current => galleryGo(current, productId, count, delta))'); // functional update: no stale closure
  });
});

describe('the rest of the product page is untouched', () => {
  const page = readFileSync('components/storefront/pages/product-detail-page.tsx', 'utf8');
  it('the thumbnail list, mobile dots, wishlist button and counter keep their existing markup and labels', () => {
    expect(page).toContain('className="gallery-thumbnails"');
    expect(page).toContain("['FRONT', 'BACK', 'DETAIL', 'FIT'][index] || `VIEW ${index + 1}`");
    expect(page).toContain('aria-label={`View product image ${index + 1}`}');
    expect(page).toContain('className="gallery-mobile-dots"');
    expect(page).toContain('aria-label="Save product"');
    expect(page).toContain('className="gallery-image-number"');
    expect(page).toContain('<SmartImage src={currentImage} alt={`${product.name} view ${activeImage + 1}`} eager />'); // main image: same loading priority
  });
  it('there is no zoom or lightbox in the gallery (none existed), and none was added', () => {
    expect(page).not.toMatch(/lightbox|zoom/i);
    expect(readFileSync('lib/hooks/use-product-gallery.ts', 'utf8')).not.toMatch(/lightbox|zoom/i);
  });
  it('purchase, size, colour, review and recommendation code is still there', () => {
    for (const marker of ['const add = (goToCheckout = false)', 'id="size-picker"', 'detail-colour-block', 'onToggleWishlist(product.id)', 'checkDelivery', 'submitReview', 'ProductGrid']) expect(page, marker).toContain(marker);
  });
  it('the arrows are real buttons with the requested accessible names, placed in the main image, with a visible focus ring and larger touch targets on touch screens', () => {
    expect(page).toContain('type="button" className="gallery-arrow gallery-arrow-prev" onClick={() => gallery.go(-1)} aria-label="Previous product image"');
    expect(page).toContain('type="button" className="gallery-arrow gallery-arrow-next" onClick={() => gallery.go(1)} aria-label="Next product image"');
    expect(page.indexOf('gallery-arrow-prev')).toBeGreaterThan(page.indexOf('className="gallery-main"'));
    expect(page.indexOf('gallery-arrow-next')).toBeLessThan(page.indexOf('className="gallery-thumbnails"'));
    const css = readFileSync('app/globals.css', 'utf8');
    expect(css).toMatch(/\.gallery-arrow:focus-visible \{\s*outline: 2px solid var\(--ink, #161715\);[^}]*opacity: 1;/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.gallery-arrow \{\s*width: 40px;\s*height: 40px;/);
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.gallery-arrow \{\s*opacity: \.55;/); // quieter with a mouse, never invisible
    expect(css).toMatch(/\.gallery-arrow \{[^}]*border-radius: 50%;/);
  });
  it('the active thumbnail is marked for assistive technology too, not by colour alone', () => {
    expect(page).toContain("aria-current={activeImage === index ? 'true' : undefined}");
    expect(page).toContain("aria-current={activeImage === idx ? 'true' : undefined}");
  });
});
