import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIZE_OPTIONS } from '@/lib/catalog';
import { blankProductDraft, editorAfterSuccessfulSave, saveSuccessMessage, upsertProduct } from '@/lib/product-editor';

const source = readFileSync('components/admin/products.tsx', 'utf8').replace(/\r\n/g, '\n');
const onSuccess = source.slice(source.indexOf('onSuccess: async (saved, variables)'), source.indexOf('onError: failure'));
const onError = source.slice(source.indexOf('onError: failure'), source.indexOf('const removeMutation'));
const product = (id: string, name = id) => ({ id, name });

describe('blank product defaults', () => {
  it('keeps the existing defaults unchanged', () => {
    const d = blankProductDraft('cat-1');
    expect(d).toMatchObject({ name: '', slug: '', categoryId: 'cat-1', price: 999, compareAt: 0, color: 'Black', colorHex: '#242424', badge: '', images: [], fit: 'Regular fit', material: '100% Cotton', description: '', bestSeller: false, newArrival: true, luxe: false, status: 'active', returnable: true, exchangeable: true, codEnabled: true, onlinePaymentEnabled: true, stockMessageMode: 'none' });
    expect(d.id).toBeUndefined();
    expect(Object.keys(d.stock)).toEqual([...SIZE_OPTIONS]);
    expect(d.stock.XXL).toBe('');
    expect(d.stock.M).toBe('10');
  });
  it('returns a fresh object each time (no shared mutable state)', () => {
    const a = blankProductDraft('x'); const b = blankProductDraft('x');
    expect(a).not.toBe(b); expect(a.images).not.toBe(b.images); expect(a.stock).not.toBe(b.stock);
  });
});

describe('editor after a confirmed save', () => {
  it('is a blank new-product form with nothing selected and no errors — for create and update alike', () => {
    const s = editorAfterSuccessfulSave('cat-9');
    expect(s).toMatchObject({ selectedId: '', showForm: true, errors: [] });
    expect(s.draft).toEqual(blankProductDraft('cat-9'));
    expect(s.draft.id).toBeUndefined();
    expect(s.draft.images).toEqual([]);
  });
  it('uses the exact success messages', () => {
    expect(saveSuccessMessage(false)).toBe('Product created successfully. You can add another product now.');
    expect(saveSuccessMessage(true)).toBe('Product updated successfully. You can add another product now.');
  });
});

describe('product list after save', () => {
  const base = { items: [product('a', 'A'), product('b', 'B')], total: 2, page: 1, pageSize: 20 };
  it('adds a created product once, keeping the others', () => {
    const next = upsertProduct(base, product('c', 'C'));
    expect(next.items.map(i => i.id)).toEqual(['c', 'a', 'b']);
    expect(next.total).toBe(3);
    expect(next.page).toBe(1);
  });
  it('replaces an updated product in place without duplicating or removing it', () => {
    const next = upsertProduct(base, product('b', 'B2'));
    expect(next.items).toEqual([product('a', 'A'), product('b', 'B2')]);
    expect(next.total).toBe(2);
  });
  it('is idempotent when the same saved product arrives twice', () => {
    const once = upsertProduct(base, product('c')); const twice = upsertProduct(once, product('c'));
    expect(twice.items.filter(i => i.id === 'c')).toHaveLength(1);
    expect(twice.total).toBe(3);
  });
});

describe('products.tsx wiring', () => {
  it('resets the editor from the success handler only, for both create and update', () => {
    expect(onSuccess).toContain('editorAfterSuccessfulSave(');
    expect(onSuccess).toContain('setSelectedId(next.selectedId)');
    expect(onSuccess).toContain('setShowForm(next.showForm)');
    expect(onSuccess).toContain('setDraft(next.draft)');
    expect(onSuccess).toContain('saveSuccessMessage(Boolean(variables.id))');
    expect(onSuccess).not.toMatch(/if \(variables\.id\)/); // no separate update branch that keeps the product selected
    expect(onSuccess).not.toContain('fromProduct(saved)');
  });
  it('remounts the form after a save to drop uploader previews, progress and local input state', () => {
    expect(source).toContain('key={formNonce}');
    expect(onSuccess).toContain('setFormNonce(');
  });
  it('failure handler never clears the form, draft or selection', () => {
    expect(onError).toContain('setFormErrors([errorMessage(failure)])');
    expect(onError).not.toMatch(/setDraft|setSelectedId|setShowForm|setFormNonce/);
  });
  it('keeps duplicate-submit protection and the disabled loading state', () => {
    expect(source).toContain('if (!draft || saveMutation.isPending) return;');
    expect(source).toContain('disabled={saveMutation.isPending}');
    expect(source).toContain("saveMutation.isPending ? 'Saving…'");
  });
  it('does not navigate, reload or force a jump to the top', () => {
    expect(onSuccess).not.toMatch(/router\.|location\.|scrollTo\(|reload/);
    expect(onSuccess).not.toContain("behavior: 'smooth'");
    expect(onSuccess).toContain('top < 0'); // only scrolls when the editor heading is already above the viewport
  });
  it('keeps search and filter state untouched by a save', () => {
    expect(onSuccess).not.toMatch(/setQuery\(|setMerchFilters|setLowOnly/);
  });
  it('uses the shared default draft for the Add product button too', () => {
    expect(source).toContain('blankProductDraft(categories[0]?.id');
  });
});
