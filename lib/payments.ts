import type { CreateOrderResponse } from '@/lib/api/schemas';

/**
 * Decides what the browser does after the server created an order.
 *
 * The browser NEVER decides that a payment succeeded. Outcomes here only say where to go next;
 * the confirmation page always re-reads the order and reports the payment status the server holds
 * (set from the provider's signature-verified callback or webhook).
 */
export type PaymentNext =
  | { type: 'confirmation' }
  | { type: 'redirect'; url: string }
  | { type: 'razorpay'; paymentId: string; payload: Record<string, unknown> }
  | { type: 'unsupported'; provider: string };

export function planPaymentNext(result: CreateOrderResponse): PaymentNext {
  const action = result.payment.action;
  if (!action) return { type: 'confirmation' };
  if (action.type === 'redirect') return { type: 'redirect', url: action.url };
  if (action.provider === 'razorpay') return { type: 'razorpay', paymentId: result.payment.id, payload: action.payload };
  return { type: 'unsupported', provider: action.provider };
}

export const confirmationPath = (orderId: string, token: string) =>
  `/order-confirmation?order=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`;
