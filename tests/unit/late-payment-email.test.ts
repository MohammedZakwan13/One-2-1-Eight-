import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvCache } from '@/lib/env';

/**
 * A payment that arrives for an order that was ALREADY cancelled (settle_payment → { changed: true, needs_refund: true }) must never
 * send a normal "we received your order" email. A normal payment must still send exactly one. Both entry points are covered:
 * the browser verification route (POST /payments/:id/verify) and the signed Razorpay webhook.
 */
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown) => Promise<unknown>>(),
  settled: { data: null as unknown, error: null as { message: string } | null },
  sendOrderEmail: vi.fn(async () => ({ status: 'accepted' })),
  eventInsertError: null as { code: string } | null,
}));

const PAYMENT_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

const fakeDb = {
  rpc: async (name: string) => (name === 'settle_payment' ? h.settled : { data: null, error: null }),
  from(table: string) {
    const result = (value: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value }) }) }) });
    if (table === 'payments') return result({ id: PAYMENT_ID, provider: 'razorpay', provider_order_id: 'rzp_order_1', order_id: ORDER_ID });
    if (table === 'orders') return result({ customer_id: 'cust-1' });
    if (table === 'webhook_events') return { insert: async () => ({ error: h.eventInsertError }), delete: () => ({ eq: () => ({ eq: async () => ({}) }) }) };
    throw new Error(`unexpected table ${table}`);
  },
};

vi.mock('@/lib/backend/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/backend/core')>()),
  route: (method: string, pattern: string, handler: (ctx: unknown) => Promise<unknown>) => { h.handlers.set(`${method} ${pattern}`, handler); },
  db: () => fakeDb,
}));
vi.mock('@/lib/backend/auth', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/backend/auth')>()), requireCustomer: async () => ({ id: 'cust-1' }), currentCustomer: async () => null }));
vi.mock('@/lib/backend/data', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/backend/data')>()), loadOrder: async () => ({ id: ORDER_ID }), orderMailData: () => ({ id: ORDER_ID }), toOrder: (row: unknown) => row }));
vi.mock('@/lib/backend/integrations', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/backend/integrations')>()),
  sendOrderEmail: h.sendOrderEmail, verifyRazorpayPayment: () => true, verifyRazorpayWebhook: () => true,
}));

const ENV = { APP_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a', RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 'sekret', RAZORPAY_WEBHOOK_SECRET: 'whsec' };
const saved = { ...process.env };
beforeEach(() => { Object.assign(process.env, ENV); resetServerEnvCache(); h.sendOrderEmail.mockClear(); h.eventInsertError = null; h.settled = { data: null, error: null }; vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { process.env = { ...saved }; resetServerEnvCache(); vi.restoreAllMocks(); });

const LATE = { changed: true, payment_status: 'paid', needs_refund: true };
const NORMAL = { changed: true, payment_status: 'paid' };
const REPEAT = { changed: false, payment_status: 'paid' };

describe('browser payment verification route', () => {
  const verify = async () => {
    await import('@/lib/backend/routes/storefront');
    const handler = h.handlers.get('POST /payments/:id/verify')!;
    expect(handler).toBeTypeOf('function');
    return handler({ params: { id: PAYMENT_ID }, url: new URL('http://x/api/v1/payments/x/verify'), body: async () => ({ payload: { razorpay_order_id: 'rzp_order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig' } }) });
  };

  it('late payment on a cancelled order: NO confirmation email, the response still reports the payment', async () => {
    h.settled = { data: LATE, error: null };
    expect(await verify()).toMatchObject({ status: 'paid' });
    expect(h.sendOrderEmail).not.toHaveBeenCalled();
  });
  it('normal successful payment: exactly one confirmation email, as before', async () => {
    h.settled = { data: NORMAL, error: null };
    await verify();
    expect(h.sendOrderEmail).toHaveBeenCalledTimes(1);
    expect(h.sendOrderEmail).toHaveBeenCalledWith({ id: ORDER_ID }, 'confirmation');
  });
  it('a repeated verification (already settled) sends nothing', async () => {
    h.settled = { data: REPEAT, error: null };
    await verify();
    expect(h.sendOrderEmail).not.toHaveBeenCalled();
  });
});

describe('Razorpay webhook', () => {
  const post = async () => {
    const { POST } = await import('@/app/api/webhooks/razorpay/route');
    const response = await POST(new Request('http://x/api/webhooks/razorpay', {
      method: 'POST', headers: { 'x-razorpay-signature': 'sig', 'x-razorpay-event-id': 'evt_1' },
      body: JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'rzp_order_1' } } } }),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it('late payment on a cancelled order: NO confirmation email (HTTP 200 so Razorpay does not retry)', async () => {
    h.settled = { data: LATE, error: null };
    expect(await post()).toEqual({ status: 200, body: { status: 'ok' } });
    expect(h.sendOrderEmail).not.toHaveBeenCalled();
  });
  it('normal captured payment: exactly one confirmation email, as before', async () => {
    h.settled = { data: NORMAL, error: null };
    expect((await post()).status).toBe(200);
    expect(h.sendOrderEmail).toHaveBeenCalledTimes(1);
  });
  it('duplicate webhook delivery (event id already processed): nothing is settled and nothing is sent', async () => {
    h.eventInsertError = { code: '23505' };
    expect(await post()).toEqual({ status: 200, body: { status: 'duplicate' } });
    expect(h.sendOrderEmail).not.toHaveBeenCalled();
  });
  it('the same payment reported again after settlement (changed=false) sends nothing', async () => {
    h.settled = { data: REPEAT, error: null };
    await post();
    expect(h.sendOrderEmail).not.toHaveBeenCalled();
  });
  it('a settlement error answers 500 so Razorpay retries, and sends nothing', async () => {
    h.settled = { data: null, error: { message: 'boom' } };
    expect((await post()).status).toBe(500);
    expect(h.sendOrderEmail).not.toHaveBeenCalled();
  });
});
