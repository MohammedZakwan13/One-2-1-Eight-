import type { Caller } from '@/lib/api/http';
import { cartSchema } from '@/lib/api/schemas';

/** The server owns the cart (cookie-scoped). The browser only ever displays what comes back. */
export const cartRepository = (call: Caller) => ({
  get: (signal?: AbortSignal) => call('/cart', cartSchema, { signal }),
  addItem: (variantId: string, quantity = 1) => call('/cart/items', cartSchema, { method: 'POST', body: { variantId, quantity } }),
  updateItem: (lineId: string, quantity: number) => call(`/cart/items/${encodeURIComponent(lineId)}`, cartSchema, { method: 'PATCH', body: { quantity } }),
  removeItem: (lineId: string) => call(`/cart/items/${encodeURIComponent(lineId)}`, cartSchema, { method: 'DELETE' }),
  applyCoupon: (code: string) => call('/cart/coupon', cartSchema, { method: 'PUT', body: { code } }),
  removeCoupon: () => call('/cart/coupon', cartSchema, { method: 'DELETE' }),
});
