import { z } from 'zod';
import type { Caller } from '@/lib/api/http';
import { categorySchema, collectionListSchema, inventoryAvailabilitySchema, productListSchema, productSchema, serviceabilitySchema } from '@/lib/api/schemas';
import { isApiError } from '@/lib/api/errors';

export type ProductListParams = {
  category?: string;
  collection?: string;
  q?: string;
  ids?: string[];
  sort?: 'featured' | 'new' | 'price-low' | 'price-high' | 'rating';
  page?: number;
  pageSize?: number;
};

const categoryListSchema = z.object({ items: z.array(categorySchema) });

export const catalogRepository = (call: Caller) => ({
  listProducts: (params: ProductListParams = {}, signal?: AbortSignal) =>
    call('/products', productListSchema, {
      query: { category: params.category, collection: params.collection, q: params.q, ids: params.ids?.join(','), sort: params.sort, page: params.page, pageSize: params.pageSize },
      revalidate: 60, tags: ['products'], signal,
    }),
  /** Returns null when the product does not exist. */
  async getProduct(slug: string) {
    try {
      return await call(`/products/${encodeURIComponent(slug)}`, productSchema, { revalidate: 60, tags: ['products', `product:${slug}`] });
    } catch (error) {
      if (isApiError(error) && error.status === 404) return null;
      throw error;
    }
  },
  related: (slug: string, limit = 4) =>
    call(`/products/${encodeURIComponent(slug)}/related`, productListSchema, { query: { limit }, revalidate: 60, tags: ['products'] }),
  listCategories: () => call('/categories', categoryListSchema, { revalidate: 300, tags: ['content'] }),
  listCollections: () => call('/collections', collectionListSchema, { revalidate: 300, tags: ['content'] }),
  /** Live per-size availability, used to refresh the size picker without re-rendering the page. */
  availability: (variantIds: string[], signal?: AbortSignal) =>
    call('/inventory/availability', inventoryAvailabilitySchema, { query: { variantIds: variantIds.join(',') }, signal, retries: 1 }),
  /** Real pincode serviceability from the courier / backend. */
  serviceability: (pincode: string, signal?: AbortSignal) =>
    call('/serviceability', serviceabilitySchema, { query: { pincode }, signal }),
});
