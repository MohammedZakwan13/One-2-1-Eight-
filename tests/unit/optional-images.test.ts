import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminCategoryCreateSchema, adminCategoryUpdateSchema, adminProductInputSchema, categorySchema, orderLineSchema, productSchema } from '@/lib/api/schemas';
import { deletableImages, releasedImages, resolveCategoryImage, resolveProductImages } from '@/lib/image-refs';
import { galleryGo, galleryIndex, formatGalleryCounter } from '@/lib/gallery-nav';
import { blankProductDraft } from '@/lib/product-editor';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const admin = read('lib/backend/routes/admin.ts');
const A = 'https://x.supabase.co/storage/v1/object/public/p/uploads/2026/01/a.jpg';
const B = 'https://x.supabase.co/storage/v1/object/public/p/uploads/2026/01/b.jpg';
const baseProduct = { name: 'Tee', slug: 'tee', categoryId: 'c1', price: 100, compareAt: 0, color: 'Black', colorHex: '#000000', fit: 'Regular', material: 'Cotton', description: '', bestSeller: false, newArrival: false, luxe: false, status: 'active', variants: [{ size: 'M', stock: 3 }] };

describe('product images are optional', () => {
  it('accepts a product with no images (the old "expected array to have >=1 items" error is gone)', () => {
    for (const images of [[], undefined]) {
      const r = adminProductInputSchema.safeParse({ ...baseProduct, ...(images ? { images } : {}) });
      expect(r.success).toBe(true);
    }
    expect(adminProductInputSchema.safeParse({ ...baseProduct, images: [] }).data?.images).toEqual([]);
  });
  it('still accepts products with images and still caps and validates them', () => {
    expect(adminProductInputSchema.safeParse({ ...baseProduct, images: [A, B] }).success).toBe(true);
    expect(adminProductInputSchema.safeParse({ ...baseProduct, images: Array(13).fill(A) }).success).toBe(false);
    expect(adminProductInputSchema.safeParse({ ...baseProduct, images: ['javascript:alert(1)'] }).success).toBe(false);
    expect(adminProductInputSchema.safeParse({ ...baseProduct, images: [''] }).success).toBe(false);
  });
  it('still rejects genuinely invalid products (other validation is not weakened)', () => {
    expect(adminProductInputSchema.safeParse({ ...baseProduct, images: [], name: '' }).success).toBe(false);
    expect(adminProductInputSchema.safeParse({ ...baseProduct, images: [], price: -1 }).success).toBe(false);
  });
  it('storefront and cart/order contracts accept an image-less product', () => {
    expect(productSchema.shape.images.safeParse([]).success).toBe(true);
    expect(orderLineSchema.shape.image.safeParse('').success).toBe(true);
    expect(orderLineSchema.shape.image.safeParse('javascript:x').success).toBe(false);
  });
  it('the blank new-product form still starts with no images', () => expect(blankProductDraft('c').images).toEqual([]));
});

describe('category image is optional', () => {
  it('create without an image, with an empty image, or with an image', () => {
    expect(adminCategoryCreateSchema.safeParse({ name: 'Tops', active: true }).success).toBe(true);
    expect(adminCategoryCreateSchema.safeParse({ name: 'Tops', image: '', active: true }).success).toBe(true);
    expect(adminCategoryCreateSchema.safeParse({ name: 'Tops', image: A, active: true }).success).toBe(true);
    expect(adminCategoryCreateSchema.safeParse({ name: 'Tops', image: 'data:x', active: true }).success).toBe(false);
  });
  it('update keeps "omitted" and "removed" distinct', () => {
    expect(adminCategoryUpdateSchema.parse({ name: 'Tops', active: true })).not.toHaveProperty('image');
    expect(adminCategoryUpdateSchema.parse({ name: 'Tops', image: '', active: true }).image).toBe('');
  });
  it('the category response may carry an empty image but never an unsafe one', () => {
    expect(categorySchema.safeParse({ id: '1', name: 'Tops', slug: 'tops', image: '', active: true }).success).toBe(true);
    expect(categorySchema.safeParse({ id: '1', name: 'Tops', slug: 'tops', image: 'javascript:x', active: true }).success).toBe(false);
  });
});

describe('explicit removal is distinct from unchanged', () => {
  it('products: omitted keeps stored images, [] removes them all, a list replaces them in order', () => {
    expect(resolveProductImages(undefined, [A, B])).toEqual([A, B]);
    expect(resolveProductImages([], [A, B])).toEqual([]);
    expect(resolveProductImages([B], [A, B])).toEqual([B]);
    expect(resolveProductImages([B, A], [A, B])).toEqual([B, A]); // first remaining image is the primary one
    expect(resolveProductImages([A, B], [A, B])).toEqual([A, B]); // unchanged records stay unchanged
  });
  it('categories: omitted keeps, "" removes, a new value replaces', () => {
    expect(resolveCategoryImage(undefined, 'uploads/a.jpg')).toBe('uploads/a.jpg');
    expect(resolveCategoryImage('', 'uploads/a.jpg')).toBe('');
    expect(resolveCategoryImage('uploads/b.jpg', 'uploads/a.jpg')).toBe('uploads/b.jpg');
  });
  it('backend uses these presence-based rules, not truthiness', () => {
    expect(admin).toContain('resolveProductImages(input.images, oldImages.map(imageUrl))');
    expect(admin).toContain('resolveCategoryImage(input.image, imageUrl(old.image))');
    expect(admin).not.toMatch(/input\.image\s*\|\|/);
    expect(admin).not.toMatch(/input\.images\s*\|\|/);
  });
});

describe('storage deletion safety', () => {
  it('releases only files the update stopped using', () => {
    expect(releasedImages(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
    expect(releasedImages(['a'], ['a'])).toEqual([]);
    expect(releasedImages(['a', ''], [])).toEqual(['a']);
    expect(releasedImages(['a', 'a'], [])).toEqual(['a']);
  });
  it('shared images are never deleted; unreferenced ones are; uncertain answers are kept', () => {
    const answers = new Map<string, boolean | null>([['shared', true], ['orphan', false], ['unknown', null]]);
    expect(deletableImages(['shared', 'orphan', 'unknown', 'never-asked'], answers)).toEqual(['orphan']);
  });
  it('deletion happens only after the database write, through the reference check, for all four call sites', () => {
    const product = admin.slice(admin.indexOf("rpc('save_product'"), admin.indexOf("route('GET', '/admin/products'"));
    expect(product.indexOf('if (error)')).toBeLessThan(product.indexOf('removeIfUnreferenced('));
    expect(admin.match(/removeIfUnreferenced\(/g)!.length).toBeGreaterThanOrEqual(5); // definition + product save + product delete + category update + category delete
    const refs = admin.slice(admin.indexOf('async function imageReferenced'), admin.indexOf('const categoryDto'));
    for (const table of ["from('products')", "from('categories')", "from('hero_slides')"]) expect(refs).toContain(table);
    expect(refs).toContain('return null'); // a failed lookup is "unknown", so nothing is deleted
    expect(admin).not.toMatch(/await removeStorageObjects\(\[?(oldImages|old\.image|category\.image|product\.images)/);
  });
  it('category update deletes the old file only after the row update succeeded', () => {
    const update = admin.slice(admin.indexOf("route('PUT', '/admin/categories/:id'"), admin.indexOf("route('DELETE', '/admin/categories/:id'"));
    expect(update.indexOf("from('categories').update(")).toBeLessThan(update.indexOf('removeIfUnreferenced'));
  });
});

describe('admin editors', () => {
  const categories = read('components/admin/collections.tsx');
  it('category create no longer demands an image, and removal is sent explicitly as an empty image', () => {
    expect(categories).not.toContain('Add a category image before saving');
    expect(categories).toContain("image: images[0] ?? ''");
    expect(categories).toContain('image: category.image, active: category.active');
  });
  it('category update cannot be fired twice while a save is pending; the editor stays open on failure', () => {
    expect(categories).toContain('if (draft.id && updateCategory.isPending) return;');
    expect(categories).toContain("updateCategory.mutate(draft, { onSuccess: () => { setDraft(null);");
    expect(categories).toContain('disabled={updateCategory.isPending || createCategory.isPending}');
  });
  it('product editor keeps its duplicate-submit guard', () => expect(read('components/admin/products.tsx')).toContain('saveMutation.isPending) return;'));
  it('the uploader lets every image be removed and only touches the form value', () => {
    const uploader = read('components/admin/image-uploader.tsx');
    expect(uploader).toContain('commit(images.filter((_, i) => i !== index))');
    expect(uploader).toContain('Nothing is deleted until the save succeeds.');
  });
});

describe('storefront without images', () => {
  it('imageUrl keeps an empty image empty (never the bare bucket URL)', () => expect(read('lib/backend/core.ts')).toContain("stored === '' || stored.startsWith('/')"));
  it('cards, rails, category tiles, bag and the product page all render through SmartImage, which shows the neutral placeholder when src is empty', () => {
    const smart = read('components/ui/smart-image.tsx');
    expect(smart).toContain("!src || failed ? 'smart-image-failed'");
    expect(smart).toContain('image-fallback');
    expect(read('components/storefront/product-card.tsx')).toContain("product.images[0] ?? ''");
    expect(read('components/storefront/luxe-rail.tsx')).toContain("product.images[0] ?? ''");
    expect(read('components/storefront/pages/home-page.tsx')).toContain('<SmartImage src={category.image}');
    expect(read('components/storefront/pages/product-detail-page.tsx')).toContain("galleryImages[activeImage] || ''");
  });
  it('the product gallery logic copes with zero images', () => {
    expect(galleryIndex({ id: 'p', index: 0 }, 'p', 0)).toBe(0);
    expect(galleryGo({ id: 'p', index: 0 }, 'p', 0, 1)).toMatchObject({ index: 0 });
    expect(formatGalleryCounter(0, 0).total).toBeDefined();
  });
  it('arrows and thumbnails only render with 2+ images', () => expect(read('components/storefront/pages/product-detail-page.tsx')).toContain('{hasMultipleImages && <button type="button" className="gallery-arrow gallery-arrow-prev"'));
});
