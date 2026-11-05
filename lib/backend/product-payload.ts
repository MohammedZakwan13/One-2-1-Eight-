import { z } from 'zod';
import type { adminProductInputSchema } from '@/lib/api/schemas';
import { HttpError, storedImage } from '@/lib/backend/core';

/** The jsonb passed to save_product. `variants` / `expected_stock` are present ONLY when the admin explicitly changed stock (or is creating the product). */
export const productPayload = (input: z.infer<typeof adminProductInputSchema>, id?: string) => ({
  id: id ?? '', slug: input.slug, name: input.name, category_id: input.categoryId, price: input.price, compare_at: input.compareAt, color: input.color, color_hex: input.colorHex,
  badge: input.badge ?? '', images: input.images.map(storedImage), fit: input.fit, material: input.material, description: input.description, best_seller: input.bestSeller,
  new_arrival: input.newArrival, luxe: input.luxe, status: input.status, stock_display: 'status', stock_message: input.stockMessage?.trim() ?? '',
  ...(input.stockMessageMode ? { stock_message_mode: input.stockMessageMode } : {}),
  ...(input.stockMessageNumber !== undefined ? { stock_message_number: input.stockMessageNumber } : {}),
  returnable: input.returnable === false ? false : true,
  exchangeable: input.exchangeable === false ? false : true,
  cod_enabled: input.codEnabled === false ? false : true,
  online_payment_enabled: input.onlinePaymentEnabled === false ? false : true,
  // Stock is written only on explicit intent: no `variants` key means save_product leaves every size untouched.
  ...(input.variants ? { variants: input.variants.map(v => ({ size: v.size, sku: v.sku ?? '', stock: v.stock })) } : {}),
  ...(id && input.variants && input.expectedStock ? { expected_stock: input.expectedStock } : {}),
});

/** Maps save_product's raised exceptions to API errors. Returns null for anything it does not recognise. */
export function saveProductError(error: { message?: string | null }): HttpError | null {
  const message = error.message ?? '';
  if (message.includes('stock_conflict')) {
    return new HttpError(409, 'stock_conflict', 'Stock for this product changed after you opened it (an order or another update). Nothing was saved. Refresh the product and enter the stock change again.');
  }
  if (message.includes('stock_snapshot_required')) {
    return new HttpError(409, 'stock_snapshot_required', 'This product was saved from an out-of-date admin page, so nothing was saved. Refresh the page and try again.');
  }
  if (message.includes('variants_required')) {
    return new HttpError(422, 'validation_failed', 'A new product needs at least one size with stock.', { variants: ['Required'] });
  }
  return null;
}
