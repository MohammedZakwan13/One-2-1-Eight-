import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminProductInputSchema, type AdminProduct } from '../../lib/api/schemas';
import { adminProductToDraft } from '../../lib/catalog';
import { lowStockSizes, stockLine, summarizeLowStock, type LowStockRow } from '../../lib/inventory';

const row = (productId: string, name: string, size: string, stock: number): LowStockRow => ({ productId, name, size, sku: `${productId}-${size}`, stock });
const rows = [
  row('grey', 'Grey T-Shirt', 'M', 3), row('grey', 'Grey T-Shirt', 'XL', 10),
  row('hoodie', 'Black Hoodie', 'L', 2), row('hoodie', 'Black Hoodie', 'XL', 1),
  row('white', 'White Sweatshirt', 'S', 1),
  row('navy', 'Navy T-Shirt', 'M', 8),
  row('sold', 'Sold out', 'M', 0),
  row('four', 'Four units', 'M', 4),
];

describe('Low Stock KPI (single calculation, threshold 3)', () => {
  it('counts unique products with a size at 1..3 and excludes 0 and 4+', () => {
    const summary = summarizeLowStock(rows, 3);
    expect(summary.count).toBe(3); // grey, hoodie, white
    expect(summary.items.map(item => `${item.name} ${item.size} ${item.stock}`)).toEqual(['Black Hoodie XL 1', 'White Sweatshirt S 1', 'Black Hoodie L 2', 'Grey T-Shirt M 3']);
  });
  it('has inclusive boundaries at the configured threshold', () => {
    for (const stock of [1, 2, 3]) expect(summarizeLowStock([row('p', 'P', 'M', stock)], 3).count).toBe(1);
    expect(summarizeLowStock([row('p', 'P', 'M', 4)], 3).count).toBe(0);
    expect(summarizeLowStock([row('p', 'P', 'M', 0)], 3).count).toBe(0);
    expect(summarizeLowStock([row('p', 'P', 'M', 4)], 5).count).toBe(1); // follows the setting, nothing hardcoded
  });
  it('counts a product once even with many low sizes, and handles products with no sizes', () => {
    expect(summarizeLowStock([row('p', 'P', 'S', 1), row('p', 'P', 'M', 2), row('p', 'P', 'L', 3)], 3).count).toBe(1);
    expect(summarizeLowStock([], 3)).toEqual({ count: 0, items: [] });
  });
  it('updates when stock is restocked or reduced', () => {
    expect(summarizeLowStock([row('p', 'P', 'M', 2)], 3).count).toBe(1);
    expect(summarizeLowStock([row('p', 'P', 'M', 12)], 3).count).toBe(0); // restocked
    expect(summarizeLowStock([row('p', 'P', 'M', 12)].map(r => ({ ...r, stock: 1 })), 3).count).toBe(1); // reduced
  });
  it('Review Stock (product-list filter) shows exactly the dashboard products and sizes', () => {
    const byProduct = new Map<string, { size: string; stock: number }[]>();
    for (const r of rows) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), { size: r.size, stock: r.stock }]);
    const listed = [...byProduct.entries()].map(([id, variants]) => ({ id, low: lowStockSizes(variants, 3) })).filter(entry => entry.low.length > 0);
    const dashboard = summarizeLowStock(rows, 3, 100);
    expect(listed.length).toBe(dashboard.count);
    for (const entry of listed) {
      const fromDashboard = dashboard.items.filter(item => item.productId === entry.id).map(item => `${item.size}:${item.stock}`).sort();
      expect(entry.low.map(variant => `${variant.size}:${variant.stock}`).sort()).toEqual(fromDashboard);
    }
  });
});

describe('legacy stock message in the editor', () => {
  const legacy = {
    id: '11111111-1111-4111-8111-111111111111', name: 'Go high', slug: 'go-high', categoryId: '22222222-2222-4222-8222-222222222222', price: 599, compareAt: 0, color: 'Black', colorHex: '#242424',
    badge: null, images: ['https://example.com/a.jpg'], stockMessage: 'Only 1 left', stockMessageMode: 'custom' as const, stockMessageReview: true,
    fit: 'Regular fit', material: '100% Cotton', description: 'x', bestSeller: false, newArrival: false, luxe: false, status: 'active' as const,
    variants: [{ id: '33333333-3333-4333-8333-333333333333', sku: 'GO-M', size: 'M', stock: 1, availability: { status: 'low_stock' as const } }],
  } as unknown as AdminProduct;
  const toInput = (draft: ReturnType<typeof adminProductToDraft>) => ({
    name: draft.name, slug: draft.slug, categoryId: draft.categoryId, price: draft.price, compareAt: draft.compareAt, color: draft.color, colorHex: draft.colorHex, images: draft.images,
    fit: draft.fit, material: draft.material, description: draft.description, bestSeller: draft.bestSeller, newArrival: draft.newArrival, luxe: draft.luxe, status: draft.status,
    stockMessage: draft.stockMessage, stockMessageMode: draft.stockMessageMode, stockMessageNumber: draft.stockMessageNumber.trim() === '' ? null : Number(draft.stockMessageNumber), variants: [{ size: 'M', stock: 1 }],
  });
  it('loads the existing message into the draft unchanged, as a Custom Stock Note under review', () => {
    const draft = adminProductToDraft(legacy);
    expect(draft.stockMessage).toBe('Only 1 left');
    expect(draft.stockMessageMode).toBe('custom');
    expect(draft.stockMessageReview).toBe(true);
  });
  it('is rejected as-is (unverified quantity claim) but can be reworded, cleared, or switched and saved', () => {
    const draft = adminProductToDraft(legacy);
    expect(adminProductInputSchema.safeParse(toInput(draft)).success).toBe(false);
    expect(adminProductInputSchema.safeParse({ ...toInput(draft), stockMessage: 'Limited drop' }).success).toBe(true);
    expect(adminProductInputSchema.safeParse({ ...toInput(draft), stockMessage: '' }).success).toBe(true);
    expect(adminProductInputSchema.safeParse({ ...toInput(draft), stockMessageMode: 'real', stockMessage: 'left' }).success).toBe(true);
    expect(adminProductInputSchema.safeParse({ ...toInput(draft), stockMessageMode: 'none' }).success).toBe(true); // text kept, simply not shown
  });
  it('message edits carry no inventory: only variants[].stock can hold stock', () => {
    const edited = adminProductInputSchema.safeParse({ ...toInput(adminProductToDraft(legacy)), stockMessage: 'Limited drop' });
    expect(edited.success && edited.data.variants).toEqual([{ size: 'M', stock: 1 }]);
  });
});

describe('Stock message editor layout (regression for the collapsed input)', () => {
  const tsx = readFileSync('components/admin/products.tsx', 'utf8');
  const css = readFileSync('app/globals.css', 'utf8');
  it('does not nest the text input inside .admin-feature-flags (that class forces inputs to 13px)', () => {
    expect(css).toMatch(/\.admin-feature-flags input[^{]*\{[^}]*width:\s*13px\s*!important/);
    const section = tsx.slice(tsx.indexOf('<legend>Stock message</legend>') - 80, tsx.indexOf('</fieldset>', tsx.indexOf('<legend>Stock message</legend>')));
    expect(section).toContain('className="admin-stock-message"');
    expect(section).not.toContain('admin-feature-flags');
    expect(section).toContain('admin-stock-message-field');
  });
  it('offers exactly two exclusive checkboxes bound to one mode value and one display-number input (custom mode only)', () => {
    const section = tsx.slice(tsx.indexOf('<legend>Stock message</legend>'), tsx.indexOf('</fieldset>', tsx.indexOf('<legend>Stock message</legend>')));
    expect((section.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(section).toContain("e.target.checked ? 'real' : 'none'");
    expect(section).toContain("e.target.checked ? 'custom' : 'none'");
    expect(section).toContain("patch('stockMessageNumber'");
    expect(section).toContain('Custom display number (not real inventory)');
    expect((section.match(/type="number"/g) ?? []).length).toBe(1); // only the custom display number; real quantities are read-only list items
  });
  it('gives the message field full width and a normal height', () => {
    expect(css).toMatch(/\.admin-edit-form input[\s\S]{0,400}width:\s*100%/);
    expect(css).toMatch(/\.admin-stock-message-field\s*\{[^}]*width:\s*100%/);
  });
});

describe('custom display number persistence and isolation from inventory', () => {
  const product = {
    id: '11111111-1111-4111-8111-111111111111', name: 'Go high', slug: 'go-high', categoryId: '22222222-2222-4222-8222-222222222222', price: 599, compareAt: 0, color: 'Black', colorHex: '#242424',
    badge: null, images: ['https://example.com/a.jpg'], stockMessage: 'left', stockMessageMode: 'custom' as const, stockMessageNumber: 3, stockMessageReview: false,
    fit: 'Regular fit', material: '100% Cotton', description: 'x', bestSeller: false, newArrival: false, luxe: false, status: 'active' as const,
    variants: [{ id: '33333333-3333-4333-8333-333333333333', sku: 'GO-M', size: 'M', stock: 20, availability: { status: 'in_stock' as const } }],
  } as unknown as AdminProduct;
  it('restores both saved values when the product is reopened', () => {
    const draft = adminProductToDraft(product);
    expect([draft.stockMessageMode, draft.stockMessageNumber, draft.stockMessage]).toEqual(['custom', '3', 'left']);
    expect(draft.stock.M).toBe('20'); // real stock is untouched and separate
  });
  it('a display number is only valid in Custom mode: Real and None must carry none', () => {
    const draft = adminProductToDraft(product);
    const input = (mode: 'none' | 'real' | 'custom', number: number | null) => adminProductInputSchema.safeParse({
      name: draft.name, slug: draft.slug, categoryId: draft.categoryId, price: draft.price, compareAt: draft.compareAt, color: draft.color, colorHex: draft.colorHex, images: draft.images,
      fit: draft.fit, material: draft.material, description: draft.description, bestSeller: false, newArrival: false, luxe: false, status: 'active', stockMessage: 'left', stockMessageMode: mode, stockMessageNumber: number,
    });
    expect(input('custom', 3).success).toBe(true);
    expect(input('real', 3).success).toBe(false);
    expect(input('none', 3).success).toBe(false);
    expect(input('real', null).success).toBe(true);
    expect(stockLine('real', draft.stockMessage, 20, 3)).toBe('20 left'); // even if a number were present, Real mode never uses it
  });
  it('Low Stock ignores display numbers: only real stock counts', () => {
    const rows = [row('a', 'A', 'M', 20), row('b', 'B', 'M', 2)].map(r => ({ ...r, stockMessageNumber: 1, stockMessage: 'left' }));
    expect(summarizeLowStock(rows, 3).count).toBe(1); // A shows "1 left" but has 20 real units; B has 2 real units
    expect(summarizeLowStock(rows, 3).items.map(item => item.productId)).toEqual(['b']);
  });
});
