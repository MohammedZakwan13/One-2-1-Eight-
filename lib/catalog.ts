import type { AdminProduct, Category, Product, Variant } from '@/lib/api/schemas';

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

export const SIZE_OPTIONS = ['S', 'M', 'L', 'XL', 'XXL'] as const;

export type AdminProductDraft = {
  id?: string; name: string; slug: string; categoryId: string; price: number; compareAt: number; color: string; colorHex: string; badge: string;
  images: string[]; stockMessage: string; returnable: boolean; exchangeable: boolean; codEnabled: boolean; onlinePaymentEnabled: boolean;
  fit: string; material: string; description: string; bestSeller: boolean; newArrival: boolean; luxe: boolean;
  status: 'active' | 'draft'; stock: Record<string, string>;
};

export const adminProductToDraft = (product: AdminProduct): AdminProductDraft => ({
  id: product.id, name: product.name, slug: product.slug, categoryId: product.categoryId, price: product.price, compareAt: product.compareAt, color: product.color,
  colorHex: product.colorHex, badge: product.badge ?? '', images: product.images, stockMessage: product.stockMessage ?? '',
  returnable: product.returnable === false ? false : true,
  exchangeable: product.exchangeable === false ? false : true,
  codEnabled: product.codEnabled === false ? false : true,
  onlinePaymentEnabled: product.onlinePaymentEnabled === false ? false : true,
  fit: product.fit, material: product.material, description: product.description,
  bestSeller: product.bestSeller, newArrival: product.newArrival, luxe: product.luxe, status: product.status,
  stock: Object.fromEntries(SIZE_OPTIONS.map(size => [size, String(product.variants.find(variant => variant.size === size)?.stock ?? '')])),
});
