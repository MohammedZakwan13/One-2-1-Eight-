import type { Caller } from '@/lib/api/http';
import { wishlistSchema } from '@/lib/api/schemas';

/** Server-side wishlist for signed-in customers (rejects with 401 for guests). */
export const wishlistRepository = (call: Caller) => ({
  list: () => call('/me/wishlist', wishlistSchema, { retries: 0 }),
  add: (productId: string) => call(`/me/wishlist/${encodeURIComponent(productId)}`, null, { method: 'PUT' }),
  remove: (productId: string) => call(`/me/wishlist/${encodeURIComponent(productId)}`, null, { method: 'DELETE' }),
});
