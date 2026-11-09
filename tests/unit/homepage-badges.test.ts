import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('app/globals.css', 'utf8').replace(/\r\n/g, '\n');
const start = css.indexOf('/* Homepage product-card badges');
const block = css.slice(start);

describe('homepage product-card badge styling', () => {
  it('exists and is scoped to the homepage-only .product-section', () => {
    expect(start).toBeGreaterThan(0);
    const selectors = block.match(/^[^\n{}@/][^{}\n]*\{/gm) ?? [];
    for (const selector of selectors.map(s => s.trim()).filter(s => s.includes('badge') || s.includes('tags'))) expect(selector).toMatch(/\.product-section/);
    expect(block).not.toMatch(/^\.product-(badge|card-tags)|^\.discount-badge/m);
  });
  it('is readable: 11px+ on desktop, 10px+ on mobile, 26px / 23px minimum heights', () => {
    expect(block).toMatch(/min-height: 26px;[\s\S]*font-size: 11\.5px/);
    expect(block).toMatch(/@media \(max-width: 760px\)[\s\S]*min-height: 23px;[\s\S]*font-size: 10px/);
  });
  it('uses brand tokens only: champagne merchandising badge, ink discount badge, no red', () => {
    expect(block).toContain('background: var(--accent-light)');
    expect(block).toContain('background: var(--ink)');
    expect(block).not.toMatch(/red|--danger|--burgundy/);
  });
  it('keeps the tag stack clear of the wishlist button', () => {
    expect(block).toMatch(/\.product-section \.product-card-tags[^}]*max-width: min\(calc\(100% - 20px\), calc\(100cqw - 70px/);
  });
  it('leaves the card markup and discount logic untouched', () => {
    const card = readFileSync('components/storefront/product-card.tsx', 'utf8');
    expect(card).toContain('const discount = discountPercent(product);');
    expect(card).toContain('{product.badge && <span className="product-badge">{product.badge}</span>}');
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
    expect(page).toContain('className="button buy-now-button" onClick={() => add(true)}');
    expect(css).not.toMatch(/add-to-bag[^{]*\{[^}]*buy-now-blue/);
  });
});
