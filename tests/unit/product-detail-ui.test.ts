import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discountPercent, hasCompareAt, savingsAmount } from '@/lib/catalog';
import type { Product } from '@/lib/api/schemas';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const css = read('app/globals.css');
const page = read('components/storefront/pages/product-detail-page.tsx');
const viewer = read('components/storefront/image-zoom-viewer.tsx');
const share = read('components/storefront/product-share.tsx');
/** The declarations of every top-level rule whose selector list contains `selector`, joined (comments removed). */
const rule = (selector: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\n)([^\n{}@][^{}]*?)\{([^}]*)\}/g)].filter(m => m[1].split(',').map(x => x.trim()).includes(selector)).map(m => m[2]).join('\n');

describe('gallery frame (one consistent shape per product)', () => {
  it('the main frame is 2:3 for every picture, capped to the viewport, with contain-fit so the whole garment shows', () => {
    const main = rule('.gallery-main');
    expect(main).toContain('aspect-ratio: 2 / 3');
    expect(main).toContain('width: min(100%, calc(min(78vh, 740px) * 2 / 3))');
    expect(css).toMatch(/\.gallery-main \.smart-image img \{[^}]*object-fit: contain/);
    expect(css).not.toContain('--gallery-ratio');
  });
  it('thumbnails share one 2:3 shape on desktop and phones', () => {
    expect(css.match(/\.gallery-thumbnails button \{[^}]*aspect-ratio: 2 \/ 3/g)!.length).toBeGreaterThanOrEqual(3);
    expect(css).not.toMatch(/\.gallery-thumbnails button \{[^}]*aspect-ratio: 1\/1/);
  });
  it('phones use the full width; a phone held sideways is capped to its height', () => {
    expect(css).toMatch(/Phones: the 2:3 frame uses the full screen width[\s\S]*?\.gallery-main \{\s*width: 100%;/);
    expect(css).toMatch(/@media \(orientation: landscape\) \{\s*\.gallery-main \{\s*width: min\(100%, calc\(80vh \* 2 \/ 3\)\);/);
  });
});

describe('per-picture fit inside the fixed frame (a close-up that is not 2:3 must not look smaller)', () => {
  it('the page learns the proportions of each picture and gives main picture and thumbnails the same fit class; the frame itself never changes', () => {
    expect(page).toContain("import { galleryFit } from '@/lib/gallery-fit';");
    expect(page).toContain('const fitClass = (src: string) => `gallery-fit-${galleryFit(ratios[src])}`;');
    expect(page).toContain('className={fitClass(currentImage)} onNaturalSize={(width, height) => noteRatio(currentImage, width, height)}');
    expect(page).toContain('className={fitClass(image)} onNaturalSize={(width, height) => noteRatio(image, width, height)}');
    expect(page).toContain('current[src] || !(width > 0 && height > 0) ? current :'); // unchanged state is returned as is, so it can never re-render in a loop
  });
  it('a picture that fills trims with cover, centred; everything else keeps the contain rule', () => {
    expect(css).toMatch(/\.gallery-main \.smart-image\.gallery-fit-fill img,\s*\.gallery-thumbnails button \.smart-image\.gallery-fit-fill img \{\s*object-fit: cover;\s*object-position: center center;/);
    expect(css).toMatch(/\.gallery-main \.smart-image img \{[^}]*object-fit: contain/); // the default stays contain: a far-off picture is never cropped
    expect(css).not.toMatch(/gallery-fit-whole/);
  });
  it('the full-screen viewer is untouched: it always shows the whole picture', () => {
    expect(viewer).not.toContain('gallery-fit');
    expect(css).toMatch(/\.zoom-image \{[^}]*object-fit: contain/);
  });
});
describe('wishlist on phones', () => {
  it('is a 40px circle with a 20px heart and a 44px touch target; desktop stays 44px', () => {
    expect(rule('.gallery-wishlist')).toContain('width: 44px');
    const phone = css.slice(css.indexOf('/* Wishlist on phones'), css.indexOf('/* The picture is swiped on phones'));
    expect(phone).toMatch(/\.gallery-wishlist \{\s*width: 40px;\s*height: 40px;/);
    expect(phone).toMatch(/\.gallery-wishlist::after \{[^}]*inset: -2px/); // 40 + 2*2 = 44
    expect(phone).toMatch(/\.gallery-wishlist svg \{\s*width: 20px;\s*height: 20px;/);
  });
  it('keeps its handler, label and a pressed state for assistive technology', () => {
    expect(page).toContain("onClick={() => onToggleWishlist(product.id)} aria-label=\"Save product\" aria-pressed={wishlist.includes(product.id)}");
  });
});

describe('arrows: desktop keeps them, phones swipe', () => {
  it('the phone rule that hides them comes AFTER every other .gallery-arrow rule, so it wins', () => {
    const hide = css.lastIndexOf('@media (max-width: 760px) {\n  .gallery-arrow {\n    display: none;');
    expect(hide).toBeGreaterThan(-1);
    expect(css.lastIndexOf('\n.gallery-arrow {')).toBeLessThan(hide);
  });
  it('the arrow buttons are still rendered (desktop) and still call the gallery', () => {
    expect(page).toContain('className="gallery-arrow gallery-arrow-prev" onClick={() => gallery.go(-1)}');
    expect(page).toContain('className="gallery-arrow gallery-arrow-next" onClick={() => gallery.go(1)}');
  });
});

describe('share: beside the heading, customers only', () => {
  it('the guard is passed to the share button; a guest is redirected to sign-in with the product as the return path and nothing is shared', () => {
    expect(share).toContain('beforeShare && !beforeShare()');
    const guard = page.slice(page.indexOf('const beforeShare = () => {'), page.indexOf('return <><main className="product-page">'));
    expect(guard).toContain('if (customer) return true;');
    expect(guard).toContain('customerLoading');
    expect(guard).toContain('loginUrl(`/products/${product.slug}`)');
    expect(guard).toContain('return false;');
  });
  it('the guard runs BEFORE any share work (native sheet, menu, image loading)', () => {
    const trigger = share.slice(share.indexOf('const onTrigger = async () => {'), share.indexOf('const copy = async'));
    expect(trigger.indexOf('beforeShare')).toBeGreaterThan(-1);
    expect(trigger.indexOf('beforeShare')).toBeLessThan(trigger.indexOf('nativeShare('));
    expect(trigger.indexOf('beforeShare')).toBeLessThan(trigger.indexOf('setOpen(true)'));
  });
  it('is a compact 40px circle with a 44px touch target, in the heading row', () => {
    expect(rule('.detail-share')).toMatch(/width: 40px;[\s\S]*height: 40px/);
    expect(css).toMatch(/\.detail-share::after \{[^}]*inset: -2px/);
    expect(page.indexOf('<div className="detail-label-actions">')).toBeLessThan(page.indexOf('<h1>{product.name}</h1>'));
  });
});

describe('full-screen zoom viewer', () => {
  it('is a modal dialog in a portal with accessible labels, and the picture opens fitted', () => {
    expect(viewer).toContain('createPortal');
    expect(viewer).toContain('role="dialog" aria-modal="true"');
    expect(viewer).toContain('aria-label="Close full-screen view"');
    expect(viewer).toContain('aria-label="Zoom in"'); expect(viewer).toContain('aria-label="Zoom out"'); expect(viewer).toContain('aria-label="Reset zoom to fit"');
    expect(viewer).toContain('aria-label="Previous image"'); expect(viewer).toContain('aria-label="Next image"');
    expect(css).toMatch(/\.zoom-image \{[^}]*max-width: 100%;[^}]*max-height: 100%;[^}]*object-fit: contain/);
    expect(css).toMatch(/\.zoom-stage \{[^}]*grid-template-rows: minmax\(0, 1fr\)/); // a definite box, so the max-height actually fits the picture
  });
  it('locks page scrolling while open and restores it and the focus on close; Escape and arrow keys work wherever focus is', () => {
    expect(viewer).toContain("document.body.style.overflow = 'hidden'");
    expect(viewer).toContain('document.body.style.overflow = previousOverflow');
    expect(viewer).toContain('opener?.focus');
    expect(viewer).toContain("document.addEventListener('keydown'");
    for (const key of ["'Escape'", "'ArrowLeft'", "'ArrowRight'", "'Tab'"]) expect(viewer).toContain(key);
    expect(viewer).toContain("el.addEventListener('wheel', onWheel, { passive: false })");
  });
  it('desktop zoom (click, wheel, drag, buttons) and touch zoom (pinch, double-tap, pan, swipe) are both implemented, without a library', () => {
    for (const piece of ['toggleZoom', 'wheelScale', 'pinchView', 'isDoubleTap', 'stepZoom', 'gallerySwipeDelta', 'setPointerCapture']) expect(viewer).toContain(piece);
    expect(css).toMatch(/\.zoom-stage \{[^}]*touch-action: none/);
    expect(read('package.json')).not.toMatch(/zoom|lightbox|swiper|photoswipe/i);
  });
  it('is wired to the gallery: the main picture opens it on the selected image and it changes the gallery\'s selection', () => {
    expect(page).toContain('<ImageZoomViewer images={galleryImages} index={activeImage} onIndexChange={gallery.select}');
    expect(page).toContain('if (!gallery.justSwiped()) setZoomOpen(true)'); // a swipe never also opens it
  });
  it('respects reduced motion, and the phone layout moves the thumbnails to the bottom and drops the arrows and zoom buttons', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.zoom-image,/);
    expect(css).toMatch(/@media \(max-width: 760px\) \{\s*\.zoom-viewer \{[\s\S]*?\.zoom-arrow,\s*\.zoom-toolbar \{\s*display: none;/);
  });
});

describe('phone purchase bar: pricing', () => {
  const priced = (price: number, compareAt: number) => ({ price, compareAt }) as Product;
  it('savings come from the same rule as the discount percentage, so the two cannot disagree', () => {
    expect(savingsAmount(priced(699, 1299))).toBe(600);
    expect(discountPercent(priced(699, 1299))).toBe(46);
    expect(savingsAmount(priced(699, 1199))).toBe(500);
    expect(discountPercent(priced(699, 1199))).toBe(42);
  });
  it('is 0 when there is no real discount (no compare-at price, or one that is not higher)', () => {
    for (const p of [priced(699, 0), priced(699, 699), priced(699, 500)]) {
      expect(hasCompareAt(p)).toBe(false);
      expect(savingsAmount(p)).toBe(0);
      expect(discountPercent(p)).toBe(0);
    }
  });
  it('the bar shows the original price, the percentage and the saving only when there is a discount, using the shared helpers and money formatting', () => {
    expect(page).toContain('const savings = savingsAmount(product);');
    expect(page).toContain('const showSavings = discount > 0 && savings > 0;');
    const barStart = page.indexOf('<div className="mobile-sticky-info">');
    const bar = page.slice(barStart, page.indexOf('{isPurchasable', barStart));
    expect(bar).toContain('{money(product.price)}');
    expect(bar).toContain('showSavings && <del');
    expect(bar).toContain('{money(product.compareAt)}');
    expect(bar).toContain('{discount}% OFF');
    expect(bar).toContain('You save {money(savings)}');
    expect(bar).toContain("selectedSize ? `Size ${selectedSize}` : 'Choose your size'"); // no discount: the previous hint stays
    expect(bar).not.toMatch(/\d{3,}/); // no hard-coded amounts
  });
  it('the new pricing styles live only inside the phone block; the bar stays hidden everywhere else', () => {
    const phoneStart = css.indexOf('/* Price block: the selling price first and largest');
    expect(phoneStart).toBeGreaterThan(css.indexOf('/* The purchase bar: fixed above the bottom navigation'));
    expect(css.indexOf('.sticky-price strong')).toBeGreaterThan(phoneStart);
    expect(css.match(/\.sticky-(price|save|off)/g)!.length).toBeGreaterThan(0);
    // every occurrence of the new classes is indented (inside @media), never a top-level rule
    expect(css).not.toMatch(/\n\.sticky-(price|save|off)/);
    expect(css).toMatch(/\.mobile-sticky-buy \{\s*display: none\s*\}/);
  });
  it('the price is the largest element, the savings are small and green, and the footer gets room for the bar (phones only)', () => {
    expect(css).toMatch(/\.sticky-price strong \{\s*font-size: 17px;/);
    expect(css).toMatch(/\.sticky-price del \{\s*font-size: 10px;/);
    expect(css).toMatch(/\.sticky-save em \{[^}]*color: #2f7a4b/);
    expect(css).toMatch(/\.product-page ~ \.site-footer \{\s*padding-bottom: 76px/);
    expect(css).not.toMatch(/\n\.product-page ~ \.site-footer/);
  });
  it('safe-area insets are respected on the sides, and the bar stays under the bottom navigation in z-order', () => {
    expect(css).toMatch(/padding: 8px max\(12px, env\(safe-area-inset-right\)\) 8px max\(12px, env\(safe-area-inset-left\)\)/);
    expect(css).toMatch(/\.mobile-sticky-buy \{\s*position: fixed;\s*z-index: 45;/);
    expect(css).toMatch(/\.mobile-bottom-nav \{\s*position: fixed;[^}]*z-index: 50;/);
  });
});
describe('phone purchase bar: hides while the footer is in view', () => {
  const effect = page.slice(page.indexOf('const barRef = useRef'), page.indexOf('const showSavings'));
  it('an IntersectionObserver on the footer (no scroll listener) sets data-footer and is cleaned up', () => {
    expect(effect).toContain("document.querySelector('.site-footer')");
    expect(effect).toContain("bar.dataset.footer = entry.isIntersecting ? 'hide' : 'show'");
    expect(effect).toContain('footerObserver?.disconnect()');
    expect(effect).not.toMatch(/addEventListener\('scroll'/);
  });
  it('the hidden bar is not clickable, and the rule is inside the phone block', () => {
    expect(css).toMatch(/\.mobile-sticky-buy\[data-footer="hide"\] \{\s*opacity: 0;\s*visibility: hidden;\s*pointer-events: none/);
    expect(css.indexOf('[data-footer="hide"]')).toBeGreaterThan(css.lastIndexOf('@media (max-width: 760px)', css.indexOf('[data-footer="hide"]')));
  });
});
describe('phone purchase bar: scroll-aware price', () => {
  const effect = page.slice(page.indexOf('const barRef = useRef'), page.indexOf('const showSavings'));
  it('one IntersectionObserver on the in-page price row flips a data attribute on the bar: no scroll listener, no React state', () => {
    expect(effect).toContain('new IntersectionObserver(');
    expect(effect).toContain("bar.dataset.price = entry.isIntersecting ? 'compact' : 'full'");
    expect(effect).toContain('observer.observe(row)');
    expect(effect).not.toMatch(/addEventListener\('scroll'|onScroll|useState|setState/);
    expect(page).toContain('<div className="detail-price-row" ref={priceRowRef}>'); // the observed row is the original, untouched price section
    expect(page).toContain('aria-label="Purchase" ref={barRef}');
  });
  it('is limited to phones, accounts for the fixed header and the bar, and does not trust the animated position of the bar', () => {
    expect(effect).toContain("window.matchMedia('(max-width: 760px)')");
    expect(effect).toContain('if (!phone.matches) { delete bar.dataset.price; delete bar.dataset.footer; return; }');
    expect(effect).toContain("['fixed', 'sticky'].includes(getComputedStyle(header).position)");
    expect(effect).toContain('parseFloat(getComputedStyle(bar).bottom) + bar.offsetHeight');
    expect(effect).not.toContain('bar.getBoundingClientRect().top');
    expect(effect).toContain("window.addEventListener('resize', connect)");
    expect(effect).toContain('observer?.disconnect()'); // cleaned up
  });
  it('compact = price + size hint; full = original price, badge and saving; both occupy the same space so nothing shifts, and fades respect reduced motion', () => {
    expect(page).toContain('<span className="sticky-line"><small className="sticky-save">');
    expect(page).toContain('<small className="sticky-hint">');
    expect(css).toMatch(/\.sticky-line>small \{\s*grid-area: 1 \/ 1;/);
    expect(css).toMatch(/\.mobile-sticky-buy\[data-price="compact"\] \.sticky-price del,\s*\.mobile-sticky-buy\[data-price="compact"\] \.sticky-save \{\s*opacity: 0;\s*visibility: hidden;/);
    expect(css).toMatch(/\.mobile-sticky-buy\[data-price="compact"\] \.sticky-hint \{\s*opacity: 1;\s*visibility: visible/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.sticky-line>small,\s*\.sticky-price del,/);
    expect(css).not.toMatch(/\n\.mobile-sticky-buy\[data-price/); // phone block only
  });
});

describe('phone purchase bar', () => {
  it('offers both Add to bag and Buy now with the existing handlers, and an honest unavailable state', () => {
    const bar = page.slice(page.indexOf('<div className="mobile-sticky-buy"'), page.indexOf('{zoomOpen &&'));
    expect(bar).toContain('onClick={() => add()}');
    expect(bar).toContain('onClick={() => add(true)}');
    expect(bar).toContain('BUY NOW');
    expect(bar).toContain('CURRENTLY UNAVAILABLE');
    expect(bar).toContain("selectedSize ? `Size ${selectedSize}` : 'Choose your size'");
  });
  it('is fixed above the bottom navigation on phones and the in-page pair is hidden there (desktop keeps the in-page pair)', () => {
    expect(css).toMatch(/\.mobile-sticky-buy \{\s*display: none\s*\}/); // hidden by default (desktop)
    expect(css).toMatch(/\.mobile-sticky-buy \{\s*position: fixed;[^}]*bottom: 58px;/);
    expect(css).toMatch(/\.product-detail-panel \.inline-purchase \{\s*display: none/);
  });
  it('ROOT CAUSE guard: the page-enter animation leaves no transform behind (a transform would pin the fixed bar to the end of the page)', () => {
    expect(css).toMatch(/\.route-screen \{[^}]*animation: screenIn \.32s ease backwards/);
    expect(css).not.toMatch(/\.route-screen \{[^}]*animation: screenIn \.32s ease (both|forwards)/);
    const keyframes = css.slice(css.indexOf('@keyframes screenIn'), css.indexOf('.brand-mark {'));
    expect(keyframes).toContain('opacity');
    expect(keyframes).not.toMatch(/transform|translate/); // a transform here would capture position: fixed descendants (the purchase bar)
  });
});
