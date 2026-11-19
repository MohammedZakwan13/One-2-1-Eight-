import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvCache } from '@/lib/env';
import { imageUrl, isStoragePath, storedImage } from '@/lib/backend/core';
import { availability, selectRelated } from '@/lib/backend/data';
import { trackingToken, trackingUrl } from '@/lib/backend/core';
import { isCancellable } from '@/lib/backend/returns';
import { orderEmail, returnEmail, verifyOtpAccessToken, verifyRazorpayPayment, verifyRazorpayWebhook, verifyResendWebhook } from '@/lib/backend/integrations';
import { sniffImage } from '@/lib/backend/routes/admin';

const ENV = { APP_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a', RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 'sekret', RAZORPAY_WEBHOOK_SECRET: 'whsec' };
const saved = { ...process.env };
beforeEach(() => { Object.assign(process.env, ENV); resetServerEnvCache(); });
afterEach(() => { process.env = { ...saved }; resetServerEnvCache(); });

const bytes = (...values: number[]) => Uint8Array.from([...values, ...new Array(16).fill(0)]);

describe('upload validation (magic bytes, not names or MIME types)', () => {
  it('accepts real JPEG, PNG, WebP and AVIF files', () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))?.ext).toBe('jpg');
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.mime).toBe('image/png');
    expect(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))?.ext).toBe('webp');
    expect(sniffImage(Uint8Array.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))?.ext).toBe('avif');
  });
  it('rejects SVG, HTML, GIF, scripts and empty files even if they claim to be images', () => {
    const text = (value: string) => new TextEncoder().encode(value);
    for (const sample of [text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), text('<html><script>alert(1)</script>'), text('GIF89a....'), text('#!/bin/sh'), new Uint8Array(0)]) {
      expect(sniffImage(sample)).toBeNull();
    }
  });
});

describe('availability from REAL stock', () => {
  it('derives status from the real quantity and threshold, and never exposes the quantity', () => {
    expect(availability(0, 5)).toEqual({ status: 'out_of_stock' });
    expect(availability(3, 5)).toEqual({ status: 'low_stock' });
    expect(availability(5, 5)).toEqual({ status: 'low_stock' });
    expect(availability(40, 5)).toEqual({ status: 'in_stock' });
  });
});

describe('related products selection', () => {
  const v = (stock: number) => [{ stock, active: true, sort_order: 1 }];
  const row = (id: string, over: Record<string, unknown> = {}) => ({ id, status: 'active', category_id: 'c1', best_seller: false, created_at: '2026-01-01T00:00:00Z', product_variants: v(5), ...over });
  const current = row('cur');
  it('excludes the current product, drafts, sold-out products and duplicates', () => {
    const picked = selectRelated(current, [row('cur'), row('draft', { status: 'draft' }), row('gone', { product_variants: v(0) }), row('nosizes', { product_variants: [] }), row('a'), row('a')], 4);
    expect(picked.map(r => r.id)).toEqual(['a']);
  });
  it('prefers the same category, then falls back to other categories, bounded by the limit', () => {
    const picked = selectRelated(current, [row('other', { category_id: 'c2', best_seller: true }), row('same1'), row('same2'), row('other2', { category_id: 'c3' })], 3);
    expect(picked.map(r => r.id)).toEqual(['same1', 'same2', 'other']);
  });
  it('returns nothing when there is no other eligible product (correct empty state)', () => {
    expect(selectRelated(current, [row('cur')], 4)).toEqual([]);
  });
});

describe('storage paths', () => {
  it('stores bucket URLs as stable paths and rebuilds them on read', () => {
    const url = 'https://abc.supabase.co/storage/v1/object/public/media/uploads/2026/10/a.webp';
    expect(storedImage(url)).toBe('uploads/2026/10/a.webp');
    expect(imageUrl('uploads/2026/10/a.webp')).toBe(url);
    expect(isStoragePath('uploads/2026/10/a.webp')).toBe(true);
  });
  it('leaves local assets and foreign URLs untouched (and never deletes them)', () => {
    expect(storedImage('/images/products/a.webp')).toBe('/images/products/a.webp');
    expect(imageUrl('/images/products/a.webp')).toBe('/images/products/a.webp');
    expect(isStoragePath('/images/products/a.webp')).toBe(false);
    expect(isStoragePath('https://cdn.example.com/a.webp')).toBe(false);
  });
});

describe('payment signature checks', () => {
  const sign = (data: string, secret = 'sekret') => createHmac('sha256', secret).update(data).digest('hex');
  it('accepts only a correct Razorpay payment signature for that exact order', () => {
    expect(verifyRazorpayPayment('order_1', 'pay_1', sign('order_1|pay_1'))).toBe(true);
    expect(verifyRazorpayPayment('order_2', 'pay_1', sign('order_1|pay_1'))).toBe(false);
    expect(verifyRazorpayPayment('order_1', 'pay_1', sign('order_1|pay_1', 'other'))).toBe(false);
    expect(verifyRazorpayPayment('order_1', 'pay_1', '')).toBe(false);
  });
  it('verifies webhook bodies against the webhook secret over the raw body', () => {
    const body = '{"event":"payment.captured"}';
    expect(verifyRazorpayWebhook(body, sign(body, 'whsec'))).toBe(true);
    expect(verifyRazorpayWebhook(`${body} `, sign(body, 'whsec'))).toBe(false);
    expect(verifyRazorpayWebhook(body, sign(body, 'sekret'))).toBe(false);
  });
  it('is never "verified" when the provider is not configured', () => {
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET; delete process.env.RAZORPAY_WEBHOOK_SECRET;
    resetServerEnvCache();
    expect(verifyRazorpayPayment('o', 'p', sign('o|p'))).toBe(false);
    expect(verifyRazorpayWebhook('{}', sign('{}', 'whsec'))).toBe(false);
  });
});

describe('Resend webhook signature (Svix)', () => {
  const secret = `whsec_${Buffer.from('super-secret-key').toString('base64')}`;
  const body = '{"type":"email.delivered","data":{"email_id":"abc"}}';
  const sig = (id: string, ts: string) => `v1,${createHmac('sha256', Buffer.from('super-secret-key')).update(`${id}.${ts}.${body}`).digest('base64')}`;
  const now = () => String(Math.floor(Date.now() / 1000));
  it('accepts a fresh, correctly signed event', () => {
    const ts = now();
    expect(verifyResendWebhook(secret, { id: 'msg_1', timestamp: ts, signature: sig('msg_1', ts) }, body)).toBe(true);
  });
  it('rejects tampered bodies, wrong secrets, missing headers and replays older than 5 minutes', () => {
    const ts = now();
    expect(verifyResendWebhook(secret, { id: 'msg_1', timestamp: ts, signature: sig('msg_1', ts) }, `${body} `)).toBe(false);
    expect(verifyResendWebhook(`whsec_${Buffer.from('other').toString('base64')}`, { id: 'msg_1', timestamp: ts, signature: sig('msg_1', ts) }, body)).toBe(false);
    expect(verifyResendWebhook(secret, { id: null, timestamp: ts, signature: sig('msg_1', ts) }, body)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyResendWebhook(secret, { id: 'msg_1', timestamp: old, signature: sig('msg_1', old) }, body)).toBe(false);
  });
});

describe('order emails', () => {
  const order = { id: 'o1', number: '1218-1001', status: 'shipped', total: 1798, paymentMethod: 'cod', contact: { name: 'Asha <b>Rao</b>', email: 'a@b.co' }, lines: [{ name: 'Tee', size: 'M', quantity: 2 }], shipment: { carrier: 'BlueDart', trackingNumber: 'T123', trackingUrl: 'https://track.example/T123' } };
  it('escapes customer-supplied text and includes tracking for shipped orders', () => {
    const mail = orderEmail(order, 'status');
    expect(mail.html).not.toContain('<b>Rao</b>');
    expect(mail.html).toContain('T123');
    expect(mail.subject).toContain('1218-1001');
    expect(mail.text).toContain('Tracking: T123');
  });
});

describe('guest tracking token', () => {
  it('is deterministic per order, unguessable across orders and rebuilt for emails', () => {
    const a = trackingToken('11111111-1111-1111-1111-111111111111');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(trackingToken('11111111-1111-1111-1111-111111111111')).toBe(a);
    expect(trackingToken('22222222-2222-2222-2222-222222222222')).not.toBe(a);
    expect(trackingUrl('11111111-1111-1111-1111-111111111111')).toContain(`token=${a}`);
  });
  it('depends on the server secret, so it cannot be derived from the order id alone', () => {
    const before = trackingToken('o1');
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-different-secret'; resetServerEnvCache();
    expect(trackingToken('o1')).not.toBe(before);
  });
});

describe('cancellation rule', () => {
  it('allows cancelling only before the parcel ships', () => {
    for (const status of ['pending_payment', 'confirmed', 'processing', 'packed']) expect(isCancellable(status)).toBe(true);
    for (const status of ['shipped', 'delivered', 'cancelled', 'refunded']) expect(isCancellable(status)).toBe(false);
  });
});

describe('return and tracking emails', () => {
  const base = { id: 'r1', number: 'R1218-1001-1', orderNumber: '1218-1001', to: 'a@b.co', name: 'Asha <b>Rao</b>', trackUrl: 'https://shop.test/order-confirmation?order=o1&token=t' };
  it('never says a refund is complete unless the status is completed', () => {
    expect(returnEmail({ ...base, status: 'refund_pending' }).text).toContain('not complete yet');
    expect(returnEmail({ ...base, status: 'completed', refundAmount: 500, refundReference: 'UTR1' }).text).toContain('Refunded');
    expect(returnEmail({ ...base, status: 'approved' }).text).not.toContain('Refunded');
  });
  it('escapes names and links the secure tracking page', () => {
    const mail = returnEmail({ ...base, status: 'requested' });
    expect(mail.html).not.toContain('<b>Rao</b>');
    expect(mail.html).toContain('token=t');
  });
  it('adds the tracking link to order emails', () => {
    const mail = orderEmail({ id: 'o1', number: 'N1', status: 'packed', total: 10, paymentMethod: 'cod', contact: { name: 'A B', email: 'a@b.co' }, lines: [], shipment: null, trackUrl: 'https://shop.test/t' }, 'status');
    expect(mail.html).toContain('https://shop.test/t');
    expect(mail.text).toContain('Track your order: https://shop.test/t');
  });
});

describe('MSG91 OTP widget: server-side access-token verification (mocked fetch, no real SMS)', () => {
  const AUTH = 'authkey-SECRET-123';
  const TOKEN = 'header.payload.access-token-SECRET-456';
  const configure = () => { Object.assign(process.env, { MSG91_AUTH_KEY: AUTH, MSG91_WIDGET_ID: 'wid_1', MSG91_WIDGET_TOKEN_AUTH: 'tok_1' }); resetServerEnvCache(); };
  const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('posts the access token and dedicated authkey to verifyAccessToken and returns the verified 10-digit mobile', async () => {
    configure();
    const fetchMock = reply({ type: 'success', message: '919876543210' }); vi.stubGlobal('fetch', fetchMock);
    await expect(verifyOtpAccessToken(TOKEN)).resolves.toBe('9876543210');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://control.msg91.com/api/v5/widget/verifyAccessToken');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ authkey: AUTH, 'access-token': TOKEN });
  });

  it('normalises the verified identifier and refuses anything that is not a plain Indian mobile', async () => {
    configure(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const ok of ['919876543210', '+91 98765 43210', '9876543210', '+91-9876543210']) {
      vi.stubGlobal('fetch', reply({ type: 'success', message: ok }));
      await expect(verifyOtpAccessToken(TOKEN)).resolves.toBe('9876543210');
    }
    for (const bad of ['OTP verified successfully', 'success', '', '   ', '12345', '5876543210', '919876543', '91987654321012', '0919876543210', '919876543210x', 919876543210, null, undefined, { mobile: '919876543210' }]) {
      vi.stubGlobal('fetch', reply({ type: 'success', message: bad }));
      await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 422, code: 'otp_invalid' });
    }
  });

  it('does not take identity from a JWT claim or from other fields when `message` has no mobile', async () => {
    configure(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const jwt = `h.${Buffer.from(JSON.stringify({ identifier: '919123456780', mobile: '919123456780' })).toString('base64url')}.s`;
    vi.stubGlobal('fetch', reply({ type: 'success', message: 'OTP verified', mobile: '919123456780', identifier: '919123456780' }));
    await expect(verifyOtpAccessToken(jwt)).rejects.toMatchObject({ status: 422, code: 'otp_invalid' });
  });

  it('rejects invalid or expired tokens: HTTP 200 without type=success, or an error status, is a 422', async () => {
    configure(); vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [body, status] of [[{ type: 'error', message: 'invalid token' }, 200], [{}, 200], [{ type: 'SUCCESS' }, 200], [{ type: 'error' }, 401], [{ type: 'success', mobile: '9876543210' }, 400]] as const) {
      vi.stubGlobal('fetch', reply(body, status));
      await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 422, code: 'otp_invalid' });
    }
  });

  it('reports provider outages (5xx, non-JSON, network error, timeout) as a generic 502', async () => {
    configure(); vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', reply({ type: 'success' }, 503));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 502, code: 'sms_provider_error' });
    vi.stubGlobal('fetch', reply('<html>gateway</html>'));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 502 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 502, message: 'We could not verify the code. Please try again.' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 502 });
  });

  it('never logs or returns the authkey or the access token', async () => {
    configure();
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(...args); });
    vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(...args); });
    vi.spyOn(console, 'warn').mockImplementation((...args) => { logged.push(...args); });
    vi.stubGlobal('fetch', reply({ type: 'error', message: `bad ${AUTH} ${TOKEN}` }));
    const e1 = await verifyOtpAccessToken(TOKEN).catch(e => e) as Error;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`fetch failed ${AUTH} ${TOKEN}`); }));
    const e2 = await verifyOtpAccessToken(TOKEN).catch(e => e) as Error;
    for (const text of [JSON.stringify(logged), e1.message, e2.message, JSON.stringify(e1), JSON.stringify(e2)]) {
      expect(text).not.toContain(AUTH);
      expect(text).not.toContain('SECRET-456');
    }
  });

  it('answers 503 and calls nothing when the widget is not configured', async () => {
    delete process.env.MSG91_AUTH_KEY; delete process.env.MSG91_WIDGET_ID; delete process.env.MSG91_WIDGET_TOKEN_AUTH; resetServerEnvCache();
    const fetchMock = reply({ type: 'success' }); vi.stubGlobal('fetch', fetchMock);
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 503, code: 'sms_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
