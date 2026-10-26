import type { Caller } from '@/lib/api/http';
import { adminRepository } from '@/lib/api/repositories/admin';
import { authRepository } from '@/lib/api/repositories/auth';
import { cartRepository } from '@/lib/api/repositories/cart';
import { catalogRepository } from '@/lib/api/repositories/catalog';
import { contentRepository } from '@/lib/api/repositories/content';
import { ordersRepository } from '@/lib/api/repositories/orders';
import { reviewsRepository } from '@/lib/api/repositories/reviews';

export const createApi = (call: Caller) => ({
  catalog: catalogRepository(call),
  cart: cartRepository(call),
  orders: ordersRepository(call),
  auth: authRepository(call),
  reviews: reviewsRepository(call),
  content: contentRepository(call),
  admin: adminRepository(call),
});
export type Api = ReturnType<typeof createApi>;
