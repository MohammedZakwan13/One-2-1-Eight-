import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const products = read('components/admin/products.tsx');
const css = read('app/globals.css');
const block = css.slice(css.indexOf('/* Products catalogue: the empty / zero-results message'));

describe('admin products empty state', () => {
  it('keeps the exact message and only marks the results container as empty when nothing matches', () => {
    expect(products).toContain('No products match your search and filters.');
    expect(products).toContain("className={`admin-product-list${filtered.length === 0 ? ' is-empty' : ''}`}");
    expect(products).toContain('className="admin-field-note admin-product-list-empty"');
  });
  it('centres the message inside the results area only (flex on the empty list, not on the card or page)', () => {
    expect(block).toMatch(/\.admin-product-list\.is-empty\s*\{[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: center;/);
    expect(block).toMatch(/\.admin-product-list-empty\s*\{[^}]*text-align: center;/);
    expect(block).not.toMatch(/admin-product-list-card\s*\{/);
    expect(block).not.toMatch(/admin-product-editor/);
  });
  it('does not change a populated list: the rule needs .is-empty', () => {
    expect(block).not.toMatch(/^\.admin-product-list\s*\{/m);
  });
  it('is responsive: a minimum height on mobile and no horizontal overflow', () => {
    expect(block).toMatch(/@media \(max-width: 760px\)\s*\{\s*\.admin-product-list\.is-empty\s*\{\s*min-height: 200px;/);
    expect(block).toContain('overflow: hidden');
    expect(block).toContain('overflow-wrap: anywhere');
  });
  it('filtering and search logic is untouched', () => {
    expect(products).toContain('matchesMerchFilters(product, merchFilters)');
    expect(products).toContain('.toLowerCase().includes(query.toLowerCase())');
  });
});
