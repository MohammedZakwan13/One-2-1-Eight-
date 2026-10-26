import type { CreateOrderResponse } from '@/lib/api/schemas';

/**
 * Decides what the browser does after the server created an order.
 *
 * The browser NEVER decides that a payment succeeded. Outcomes here only say where to go next;
 * the confirmation page always re-reads the order and reports the payment status the server holds
 * (which, in production, is set from the payment provider's verified webhook).
 *
 * Provider integration point: to support an SDK-based gateway (Razorpay, Cashfree, PhonePe…), add a
 * case for its `provider` id that opens the SDK with `payment.action.payload`, then calls
 * `POST /payments/{id}/verify` and finally navigates to the confirmation URL.
 */
export type PaymentNext =
  | { type: 'confirmation' }
  | { type: 'redirect'; url: string }
  | { type: 'mock-gateway'; path: string }
  | { type: 'unsupported'; provider: string };

export function planPaymentNext(result: CreateOrderResponse, options: { mockEnabled: boolean }): PaymentNext {
  const action = result.payment.action;
  if (!action) return { type: 'confirmation' };
  if (action.type === 'redirect') return { type: 'redirect', url: action.url };
  if (action.provider === 'mock-gateway' && options.mockEnabled) {
    return { type: 'mock-gateway', path: `/mock-payment/${encodeURIComponent(result.payment.id)}?order=${encodeURIComponent(result.order.id)}&token=${encodeURIComponent(result.lookupToken)}` };
  }
  return { type: 'unsupported', provider: action.provider };
}

export const confirmationPath = (orderId: string, token: string) =>
  `/order-confirmation?order=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`;
