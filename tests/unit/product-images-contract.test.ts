import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCaller } from '@/lib/api/http';
import { ApiError } from '@/lib/api/errors';
import { productListSchema, productSchema, safeUrl } from '@/lib/api/schemas';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const product = (n: number, images: string[]) => ({ id: `p${n}`, slug: `piece-${n}`, name: `Piece ${n}`, category: 'T-Shirt', categorySlug: 't-shirt', price: 599, compareAt: 799, color: 'Beige', colorHex: '#d9c9a3', rating: 0, reviewCount: 0, badge: 'Trending', images, fit: 'Regular', material: 'Cotton', description: '', bestSeller: false, newArrival: true, luxe: false, variants: [{ id: `v${n}`, sku: `S${n}`, size: 'M', availability: { status: 'in_stock' } }], updatedAt: '2026-01-01T00:00:00.000Z' });
const list = (...items: ReturnType<typeof product>[]) => ({ items, total: items.length, page: 1, pageSize: 20 });
const callerReturning = (body: unknown) => createCaller(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const IMG = 'https://x.supabase.co/storage/v1/object/public/p/uploads/2026/01/a.jpg';

afterEach(() => vi.restoreAllMocks());

describe('GET /products with image-less products (the production 502)', () => {
  // The schema that was deployed in commit d0f767a: `images: z.array(safeUrl).min(1).max(12)`.
  const deployedList = z.object({ items: z.array(z.object({ images: z.array(safeUrl).min(1).max(12) })), total: z.number(), page: z.number(), pageSize: z.number() });

  it('reproduces the exact deployed failure: 502 invalid_response, path items.0.images, too_small, minimum 1', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(callerReturning(list(product(1, [])))('/products', deployedList)).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
    const issue = (spy.mock.calls[0][1] as { path: unknown[]; code: string; minimum: number }[])[0];
    expect(issue).toMatchObject({ path: ['items', 0, 'images'], code: 'too_small', minimum: 1 });
  });
  it('the fixed contract accepts one image-less product', async () => {
    const out = await callerReturning(list(product(1, [])))('/products', productListSchema);
    expect(out.items[0].images).toEqual([]);
  });
  it('accepts several image-less products', async () => {
    const out = await callerReturning(list(product(1, []), product(2, []), product(3, [])))('/products', productListSchema);
    expect(out.items.map(i => i.images.length)).toEqual([0, 0, 0]);
  });
  it('accepts a mix, preserving the images of products that have them', async () => {
    const out = await callerReturning(list(product(1, [IMG]), product(2, []), product(3, [IMG, IMG])))('/products', productListSchema);
    expect(out.items.map(i => i.images.length)).toEqual([1, 0, 2]);
    expect(out.items[0].images[0]).toBe(IMG);
  });
  it('a single product (detail page) with no images parses too', async () => {
    expect((await callerReturning(product(1, []))('/products/piece-1', productSchema)).images).toEqual([]);
  });
  it('still rejects genuinely bad data, so response validation is not weakened', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(callerReturning(list(product(1, ['javascript:alert(1)'])))('/products', productListSchema)).rejects.toBeInstanceOf(ApiError);
    await expect(callerReturning(list({ ...product(1, []), price: -5 }))('/products', productListSchema)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(callerReturning(list({ ...product(1, []), variants: [] }))('/products', productListSchema)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('no remaining one-image requirement', () => {
  it('no schema or OpenAPI definition demands a minimum of one product image', () => {
    expect(read('lib/api/schemas.ts')).not.toMatch(/images:\s*z\.array\([^)]*\)\.min\(1\)/);
    expect(read('openapi/openapi.yaml')).not.toMatch(/images:\s*\{\s*type: array,\s*minItems: 1/);
  });
  it('every storefront consumer of a product photo goes through the placeholder-aware SmartImage', () => {
    for (const file of ['components/storefront/product-card.tsx', 'components/storefront/luxe-rail.tsx']) expect(read(file)).toContain("images[0] ?? ''");
    expect(read('components/storefront/product-grid.tsx')).toContain('<ProductCard');
    for (const page of ['home-page', 'collection-page', 'search-page', 'wishlist-page']) expect(read(`components/storefront/pages/${page}.tsx`)).toMatch(/ProductGrid|ProductCard/);
    expect(read('components/storefront/pages/product-detail-page.tsx')).toContain("galleryImages[activeImage] || ''");
    expect(read('components/ui/smart-image.tsx')).toContain("!src || failed ? 'smart-image-failed'");
  });
});
