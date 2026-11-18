import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const css = read('app/globals.css');
const rule = (selector: string) => css.slice(css.indexOf(`\n${selector} {`) + 1, css.indexOf('}', css.indexOf(`\n${selector} {`)));

describe('product card photo frame (one shared 3:4 cover frame)', () => {
  it('the frame is 3:4 portrait and is declared exactly once', () => {
    expect(rule('.product-card-media')).toContain('aspect-ratio: 3 / 4');
    expect(css.match(/\n\s*\.product-card-media \{/g)).toHaveLength(2); // the frame rule + the container-type rule next to it
    expect(css).not.toMatch(/\.product-card-media \{[^}]*aspect-ratio: 1 \/ 1/);
  });
  it('the photo fills the frame without distortion: cover, a top-weighted focal point, and no !important override fighting it', () => {
    const img = rule('.product-card-media .smart-image img');
    expect(img).toContain('object-fit: cover');
    expect(img).toMatch(/object-position: 50% 15%/);
    expect(img).toContain('width: 100%');
    expect(img).toContain('height: 100%');
    expect(css).not.toMatch(/\.product-card-media[^{]*img[^{]*\{[^}]*object-fit: contain/);
    expect(css).not.toMatch(/\.product-card-media[^{]*\{[^}]*!important/);
  });
  it('every grid renders the one shared ProductCard (home rails, shop all, collections, search, related, wishlist), with no per-page image sizing', () => {
    expect(read('components/storefront/product-grid.tsx')).toContain('<ProductCard');
    for (const page of ['home-page', 'collection-page', 'search-page', 'product-detail-page', 'wishlist-page']) expect(read(`components/storefront/pages/${page}.tsx`)).toContain('<ProductGrid');
    expect(read('components/storefront/product-card.tsx')).toContain('className="product-card-media"');
  });
});
