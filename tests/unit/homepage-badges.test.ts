import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('app/globals.css', 'utf8').replace(/\r\n/g, '\n');

describe('product-card badge and wishlist styling (one shared design for every grid)', () => {
  // every top-level block whose selector list ends with this selector, joined (a selector can have a shared rule plus its own rule)
  const rule = (selector: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\n)([^\n{}@/][^{}]*?)\{([^}]*)\}/g)].filter(m => m[1].split(',').map(x => x.trim()).includes(selector) && !m[1].includes('@')).map(m => m[2]).join('\n');
  const card = readFileSync('components/storefront/product-card.tsx', 'utf8').replace(/\r\n/g, '\n');
  it('is no longer a homepage-only design: the scoped .product-section badge block is gone', () => {
    expect(css).not.toContain('/* Homepage product-card badges');
    expect(css).not.toMatch(/\.product-section \.(product-badge|discount-badge|product-card-tags)/);
  });
  it('badges are compact but readable: 26px / 10.5px on mobile (10px on narrow cards), 30px / 12px on desktop, bold, each label on one line and never truncated', () => {
    const badge = rule('.product-badge');
    expect(badge).toContain('min-height: 26px');
    expect(badge).toContain('font-size: 10.5px');
    expect(badge).toContain('font-weight: 700');
    expect(badge).toContain('white-space: nowrap');
    expect(badge).toContain('width: max-content');
    expect(badge).not.toMatch(/text-overflow|overflow: hidden/);
    expect(badge).toContain('padding: 0 8px');
    expect(rule('.discount-badge')).toContain('padding: 0 7px');
    expect(css).toMatch(/@media \(min-width: 761px\) \{[\s\S]*?\.product-badge,\s*\.discount-badge \{\s*min-height: 30px;\s*font-size: 12px/);
  });
  it('uses brand tokens only: champagne merchandising badge, ink discount badge, no red', () => {
    expect(rule('.product-badge')).toContain('background: var(--accent-light)');
    expect(rule('.discount-badge')).toContain('background: var(--ink)');
    expect(rule('.product-badge') + rule('.discount-badge')).not.toMatch(/red|--danger|--burgundy/);
  });
  it('the wishlist button is a 40px circle on phones (42px on desktop) with a 19px heart (20px on desktop) and a 44px+ touch target, with focus and saved states', () => {
    const wl = rule('.wishlist-float');
    expect(wl).toContain('width: 40px');
    expect(wl).toContain('height: 40px');
    expect(wl).toContain('position: absolute');
    expect(wl).toContain('right: 10px');
    expect(css).toMatch(/\.wishlist-float::after \{[^}]*inset: -2px/); // 40px circle + 2px each side = 44px target
    expect(rule('.wishlist-float svg')).toMatch(/width: 19px;\s*height: 19px/);
    expect(css).toMatch(/@media \(min-width: 761px\) \{[\s\S]*?\.wishlist-float \{[^}]*width: 42px/);
    expect(css).toContain('.wishlist-float:focus-visible');
    expect(css).toContain('.wishlist-float.is-saved');
    expect(card).toContain('aria-pressed={isSaved}');
  });
  it('the badges (top-left) and the wishlist (top-right) are INSIDE the photo frame and out of flow: no row above it, no extra card height', () => {
    const media = card.slice(card.indexOf('<div className="product-card-media">'), card.indexOf('<div className="product-card-info">'));
    for (const inside of ['product-card-tags', 'wishlist-float', 'product-badge', 'discount-badge']) expect(media).toContain(inside);
    expect(card).not.toContain('product-card-top');
    expect(css).not.toContain('product-card-top');
    expect(rule('.product-card-tags')).toContain('position: absolute');
    expect(rule('.product-card-tags')).toMatch(/top: 10px;\s*left: 10px/);
    expect(rule('.product-card')).toContain('container-type: inline-size');
  });
  it('the badges are stacked (NEW DROP above the discount, 4px apart) at every width, on desktop as well as mobile', () => {
    const tags = rule('.product-card-tags');
    expect(tags).toContain('flex-direction: column');
    expect(tags).toContain('align-items: flex-start');
    expect(tags).toContain('gap: 4px');
    expect(css).not.toMatch(/\.product-card-tags \{[^}]*flex-direction: row/);
    const narrowBlock = css.slice(css.indexOf('@container pcard (max-width: 205px)'), css.indexOf('.quick-add {'));
    expect(narrowBlock).not.toContain('flex-direction');
  });
  it('narrow cards (205px and under) sit closer to the corners with 10px text; nothing else about the layout changes', () => {
    const narrow = css.slice(css.indexOf('@container pcard (max-width: 205px)'));
    expect(narrow).toMatch(/\.product-card-tags \{[^}]*top: 8px;[^}]*left: 8px/);
    expect(narrow).toMatch(/font-size: 10px/);
    expect(narrow).toMatch(/\.wishlist-float \{[^}]*top: 8px;[^}]*right: 8px/);
  });
  it('leaves the card markup and discount logic untouched', () => {
    expect(card).toContain('const discount = discountPercent(product);');
    expect(card).toContain('{product.badge && <span className="product-badge">{product.badge}</span>}');
    expect(card).toContain('onClick={() => onToggleWishlist(product.id, product.name)}');
  });
});

describe('product detail BUY NOW button colour', () => {
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
  it('uses dedicated blue variables scoped to .buy-now-button, no burgundy', () => {
    const base = rule('.buy-now-button');
    expect(base).toContain('--buy-now-blue: #1f4e8c');
    expect(base).toContain('--buy-now-blue-hover: #173b6b');
    expect(base).toContain('background: var(--buy-now-blue)');
    expect(base).toContain('color: var(--white)');
    expect(rule('.buy-now-button:hover')).toContain('var(--buy-now-blue-hover)');
    expect(rule('.buy-now-button:active')).toContain('var(--buy-now-blue-active)');
    const all = css.slice(css.indexOf('.buy-now-button {'), css.indexOf('.buy-now-button svg'));
    expect(all).not.toContain('burgundy');
  });
  it('leaves Add to Bag styling and the Buy Now handler alone', () => {
    const page = readFileSync('components/storefront/pages/product-detail-page.tsx', 'utf8');
    expect(page).toContain('className="button buy-now-button inline-purchase" onClick={() => add(true)}'); // same handler; also the in-page copy hidden on phones
    expect(page).toContain('className="button buy-now-button mobile-sticky-now" onClick={() => add(true)}'); // the phone bar uses the very same handler
    expect(css).not.toMatch(/add-to-bag[^{]*\{[^}]*buy-now-blue/);
  });
});
