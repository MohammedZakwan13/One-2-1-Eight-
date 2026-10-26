import { describe, expect, it } from 'vitest';
import { confirmationPath, planPaymentNext } from '@/lib/payments';
import type { CreateOrderResponse } from '@/lib/api/schemas';

const base = (action: CreateOrderResponse['payment']['action']): CreateOrderResponse => ({
  order: { id: 'ord_1', number: '1218-1', status: 'pending_payment', paymentStatus: 'pending', paymentMethod: 'upi', currency: 'INR', totals: { subtotal: 1, discount: 0, shipping: 0, total: 1 }, lines: [], contact: { name: 'Test User', phone: '9876543210', email: 'a@b.co' }, shippingAddress: { line1: '1 Street', city: 'City', state: 'State', pincode: '560001' }, createdAt: '2026-01-01T00:00:00Z' },
  payment: { id: 'pay_1', provider: 'x', status: 'pending', action },
  lookupToken: 'tok_1234567890abcdef',
});

describe('planPaymentNext', () => {
  it('goes straight to confirmation when no browser action is required (COD / settled)', () => {
    expect(planPaymentNext(base(null), { mockEnabled: false })).toEqual({ type: 'confirmation' });
  });
  it('follows provider redirects', () => {
    expect(planPaymentNext(base({ type: 'redirect', url: 'https://pay.example-gateway.in/x' }), { mockEnabled: false })).toEqual({ type: 'redirect', url: 'https://pay.example-gateway.in/x' });
  });
  it('only honours the mock gateway when mock mode is on — production can never simulate a payment', () => {
    const mock = base({ type: 'sdk', provider: 'mock-gateway', payload: {} });
    expect(planPaymentNext(mock, { mockEnabled: true }).type).toBe('mock-gateway');
    expect(planPaymentNext(mock, { mockEnabled: false })).toEqual({ type: 'unsupported', provider: 'mock-gateway' });
  });
  it('reports unknown SDK providers instead of pretending to pay', () => {
    expect(planPaymentNext(base({ type: 'sdk', provider: 'razorpay', payload: { orderId: 'o' } }), { mockEnabled: false })).toEqual({ type: 'unsupported', provider: 'razorpay' });
  });
  it('builds a confirmation URL that carries only an order id and an opaque token', () => {
    expect(confirmationPath('ord 1', 'a/b')).toBe('/order-confirmation?order=ord%201&token=a%2Fb');
  });
});
