import { describe, expect, it } from 'vitest';
import { confirmationPath, planPaymentNext } from '@/lib/payments';
import type { CreateOrderResponse } from '@/lib/api/schemas';

const base = (action: CreateOrderResponse['payment']['action']): CreateOrderResponse => ({
  order: { id: 'ord_1', number: '1218-1', status: 'pending_payment', paymentStatus: 'pending', paymentMethod: 'upi', currency: 'INR', totals: { subtotal: 1, discount: 0, shipping: 0, total: 1 }, lines: [], contact: { name: 'Test User', phone: '9876543210', email: 'a@b.co' }, shippingAddress: { line1: '1 Street', city: 'City', state: 'State', pincode: '560001' }, createdAt: '2026-01-01T00:00:00Z', history: [], shipment: null },
  payment: { id: 'pay_1', provider: 'x', status: 'pending', action },
  lookupToken: 'tok_1234567890abcdef',
});

describe('planPaymentNext', () => {
  it('goes straight to confirmation when no browser action is required (COD / settled)', () => {
    expect(planPaymentNext(base(null))).toEqual({ type: 'confirmation' });
  });
  it('follows provider redirects', () => {
    expect(planPaymentNext(base({ type: 'redirect', url: 'https://pay.example-gateway.in/x' }))).toEqual({ type: 'redirect', url: 'https://pay.example-gateway.in/x' });
  });
  it('opens the Razorpay checkout with the server-provided payload', () => {
    expect(planPaymentNext(base({ type: 'sdk', provider: 'razorpay', payload: { orderId: 'o' } }))).toEqual({ type: 'razorpay', paymentId: 'pay_1', payload: { orderId: 'o' } });
  });
  it('reports unknown SDK providers instead of pretending to pay', () => {
    expect(planPaymentNext(base({ type: 'sdk', provider: 'other', payload: {} }))).toEqual({ type: 'unsupported', provider: 'other' });
  });
  it('builds a confirmation URL that carries only an order id and an opaque token', () => {
    expect(confirmationPath('ord 1', 'a/b')).toBe('/order-confirmation?order=ord%201&token=a%2Fb');
  });
});
