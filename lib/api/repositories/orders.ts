import type { Caller } from '@/lib/api/http';
import { createOrderResponseSchema, orderListSchema, orderSchema, paymentSchema, type CreateOrderRequest } from '@/lib/api/schemas';

export const ordersRepository = (call: Caller) => ({
  /**
   * Creates an order from the server-side cart. The server re-prices everything; the browser sends
   * no amounts. `idempotencyKey` must be stable for one checkout attempt so retries cannot double-charge.
   */
  create: (request: CreateOrderRequest, idempotencyKey: string) =>
    call('/orders', createOrderResponseSchema, { method: 'POST', body: request, idempotencyKey }),
  /** Reads an order using the lookup token returned by `create` (guest checkout) or the customer session. */
  get: (orderId: string, lookupToken?: string) =>
    call(`/orders/${encodeURIComponent(orderId)}`, orderSchema, { query: { token: lookupToken }, revalidate: false }),
  /** Completes SDK-based payments. The server verifies the signature with the provider – never trust the browser. */
  verifyPayment: (paymentId: string, payload: Record<string, unknown>) =>
    call(`/payments/${encodeURIComponent(paymentId)}/verify`, paymentSchema, { method: 'POST', body: { payload } }),
  listMine: (page = 1) => call('/me/orders', orderListSchema, { query: { page, pageSize: 20 } }),
});
