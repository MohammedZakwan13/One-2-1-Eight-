import type { Category, Product, Variant } from '@/lib/api/schemas';

/** Category tiles/menus show exactly the categories the CMS marks active – no hard-coded exclusions. */
export const isStorefrontCategory = (category: Category) => category.active;

/** Sizes offered for filtering. The product's own variants decide which sizes can actually be bought. */
export const imageSizes = ['S', 'M', 'L', 'XL', 'XXL'];

export const productSizes = (product: Product) => product.variants.map(variant => variant.size);
export const isSoldOut = (product: Product) => product.variants.every(variant => variant.availability.status === 'out_of_stock');
export const variantForSize = (product: Product, size: string): Variant | undefined => product.variants.find(variant => variant.size === size);
export const hasCompareAt = (product: Product) => product.compareAt > product.price;
export const discountPercent = (product: Product) => (hasCompareAt(product) ? Math.round((1 - product.price / product.compareAt) * 100) : 0);

/** Narrow type guard for collections handled by the API (vs. category slugs). */
export const COLLECTION_SLUGS = ['best-sellers', 'new-arrivals', 'one-2-1-eight-luxe', 'layering-edit'] as const;
