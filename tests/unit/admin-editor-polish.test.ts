import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const products = read('components/admin/products.tsx');

describe('Admin editor polish', () => {
  it('uses the wheel-safe NumberInput for every numeric product field', () => {
    expect(products).not.toMatch(/<input[^>]*type="number"/);
    expect((products.match(/<NumberInput\b/g) ?? []).length).toBe(4); // price, compare-at, size stock, custom number
    const component = read('components/admin/number-input.tsx');
    expect(component).toContain('type="number"');
    expect(component).toContain('onWheel');
    expect(component).toContain('.blur()');
    expect(component).not.toMatch(/preventDefault/); // page scrolling must keep working
  });
  it('Material reuses ComboInput instead of a native datalist', () => {
    expect(products).not.toContain('datalist');
    expect(products).toMatch(/<ComboInput value=\{draft\.material\}[\s\S]*?options=\{MATERIAL_OPTIONS\}/);
  });
  it('resets to a fresh form after create but keeps the product after update', () => {
    expect(products).toContain('variables.id');
    expect(products).toContain('blankDraft()');
    expect(products).toContain("status: 'active'");
    expect(products).toContain('scrollIntoView');
  });
  it('anchors badge and discount tags to a box sized from the photo ratio, not the square frame', () => {
    const card = read('components/storefront/product-card.tsx');
    expect(card).toMatch(/product-card-image-box[\s\S]*product-card-tags/);
    expect(card).toContain('onNaturalSize');
    const css = read('app/globals.css');
    expect(css).toMatch(/\.product-card-image-box\s*\{[^}]*var\(--img-ratio/);
    expect(css).toMatch(/\.product-card-tags\s*\{[^}]*max-width: min\(/);
    expect(css).toMatch(/\.product-card-media\s*\{\s*container-type: size/);
  });
});
