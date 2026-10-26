import { beforeEach, describe, expect, it } from 'vitest';
import {
  adminLeadListSchema, adminProductListSchema, apiErrorBodySchema, cartSchema, categorySchema, collectionListSchema, createOrderResponseSchema, dashboardSummarySchema,
  inventoryAvailabilitySchema, orderListSchema, orderSchema, productListSchema, productSchema, reviewListSchema, serviceabilitySchema, storefrontContentSchema,
} from '@/lib/api/schemas';
import { handleMockRequest } from '@/mocks/router';
import { resetServerEnvCache } from '@/lib/env';
import { MockClient, TEST_ENV, useMockEnvironment } from './helpers/mock-client';

const address = { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };
const contact = { name: 'Asha Verma', phone: '9876543210', email: 'asha@example.org' };
const orderBody = (paymentMethod: 'cod' | 'upi' | 'card' = 'cod') => ({ contact, shippingAddress: address, paymentMethod, acceptedTerms: true });

let client: MockClient;
beforeEach(() => { useMockEnvironment(); client = new MockClient(); });

describe('mock backend honours the response contract', () => {
  it('serves catalogue, content and availability that validate against the schemas', async () => {
    expect(productListSchema.parse((await client.get('/products?pageSize=50')).body).items.length).toBe(12);
    expect(productSchema.parse((await client.get('/products/essential-box-fit-tee-black')).body).variants.length).toBe(5);
    expect(collectionListSchema.parse((await client.get('/collections')).body).items.map(item => item.slug)).toContain('one-2-1-eight-luxe');
    expect(storefrontContentSchema.parse((await client.get('/content/storefront')).body).heroSlides.length).toBe(3);
    expect(reviewListSchema.parse((await client.get('/products/essential-box-fit-tee-black/reviews')).body).summary.count).toBeGreaterThan(0);
    expect(inventoryAvailabilitySchema.parse((await client.get('/inventory/availability?variantIds=p1-m,p1-l')).body).items).toHaveLength(2);
    expect(serviceabilitySchema.parse((await client.get('/serviceability?pincode=560001')).body).serviceable).toBe(true);
    expect((await client.get('/serviceability?pincode=900001')).body.serviceable).toBe(false);
    expect((await client.get('/serviceability?pincode=abc')).status).toBe(422);
  });

  it('filters by collection, category, search and ids; 404s unknown products with the error envelope', async () => {
    const luxe = productListSchema.parse((await client.get('/products?collection=one-2-1-eight-luxe')).body);
    expect(luxe.items.every(product => product.luxe)).toBe(true);
    const hoodies = productListSchema.parse((await client.get('/products?category=hoodie')).body);
    expect(hoodies.items.map(product => product.categorySlug)).toEqual(['hoodie']);
    expect(productListSchema.parse((await client.get('/products?q=polo')).body).items.length).toBeGreaterThan(0);
    expect(productListSchema.parse((await client.get('/products?ids=p1,p2')).body).items.map(product => product.id).sort()).toEqual(['p1', 'p2']);
    const missing = await client.get('/products/does-not-exist');
    expect(missing.status).toBe(404);
    expect(apiErrorBodySchema.parse(missing.body).error.code).toBe('not_found');
  });

  it('never exposes exact stock to shoppers or hidden products', async () => {
    const body = JSON.stringify((await client.get('/products?pageSize=50')).body);
    expect(body).not.toMatch(/"stock"/);
    await client.signInAdmin();
    const list = adminProductListSchema.parse((await client.get('/admin/products')).body);
    const draft = list.items[0];
    const input = { ...draft, variants: draft.variants.map(variant => ({ size: variant.size, sku: variant.sku, stock: variant.stock })), status: 'draft' as const };
    expect((await client.put(`/admin/products/${draft.id}`, input)).status).toBe(200);
    expect((await client.get(`/products/${draft.slug}`)).status).toBe(404);
  });
});

describe('cart is server-priced', () => {
  const add = (variantId: string, quantity = 1) => client.post('/cart/items', { variantId, quantity });

  it('prices lines, applies free shipping and coupons on the server', async () => {
    expect(cartSchema.parse((await client.get('/cart')).body).lines).toEqual([]);
    const cart = cartSchema.parse((await add('p1-m', 2)).body);
    expect(cart.totals).toEqual({ subtotal: 1798, discount: 0, shipping: 0, total: 1798 });

    const withCoupon = cartSchema.parse((await client.put('/cart/coupon', { code: ' welcome10 ' })).body);
    expect(withCoupon.coupon?.code).toBe('WELCOME10');
    expect(withCoupon.totals).toEqual({ subtotal: 1798, discount: 180, shipping: 0, total: 1618 });

    const removed = cartSchema.parse((await client.delete('/cart/coupon')).body);
    expect(removed.totals.discount).toBe(0);
  });

  it('charges shipping under the threshold and rejects invalid or non-applicable coupons with safe messages', async () => {
    const small = cartSchema.parse((await add('p6-m')).body); // ₹699
    expect(small.totals).toEqual({ subtotal: 699, discount: 0, shipping: 79, total: 778 });
    const unknown = await client.put('/cart/coupon', { code: 'FREEMONEY' });
    expect(unknown.status).toBe(422);
    expect(apiErrorBodySchema.parse(unknown.body).error.code).toBe('coupon_invalid');
    const minSpend = await client.put('/cart/coupon', { code: 'WELCOME10' });
    expect(minSpend.status).toBe(422);
    expect(minSpend.body.error.message).toMatch(/more to use this code/);
    const luxe = await client.put('/cart/coupon', { code: 'LUXE15' });
    expect(luxe.body.error.code).toBe('coupon_not_applicable');
  });

  it('caps quantities at available stock and refuses sold-out variants', async () => {
    const capped = cartSchema.parse((await add('p12-m', 10)).body); // stock 2
    expect(capped.lines[0].quantity).toBe(2);
    expect(capped.lines[0].maxQuantity).toBe(2);
    expect(capped.messages.join(' ')).toMatch(/Only 2/);

    await client.signInAdmin();
    const product = adminProductListSchema.parse((await client.get('/admin/products')).body).items.find(item => item.id === 'p1')!;
    const soldOut = { ...product, variants: product.variants.map(variant => ({ size: variant.size, sku: variant.sku, stock: variant.size === 'S' ? 0 : variant.stock })) };
    await client.put('/admin/products/p1', soldOut);
    const attempt = await add('p1-s');
    expect(attempt.status).toBe(409);
    expect(attempt.body.error.code).toBe('out_of_stock');
  });

  it('validates input (quantity bounds, unknown variants)', async () => {
    expect((await add('p1-m', 0)).status).toBe(422);
    expect((await add('p1-m', 21)).status).toBe(422);
    expect((await add('nope-xx')).status).toBe(404);
  });
});

describe('checkout never trusts the browser', () => {
  const key = () => `key-${Math.random().toString(36).slice(2)}-padding`;

  it('requires an idempotency key and ignores client-supplied amounts', async () => {
    await client.post('/cart/items', { variantId: 'p1-m', quantity: 2 });
    const missing = await client.post('/orders', orderBody());
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('idempotency_key_required');

    const tampered = await client.post('/orders', { ...orderBody(), totals: { total: 1 }, amount: 1, price: 1 }, { 'Idempotency-Key': key() });
    expect(tampered.status).toBe(201);
    const created = createOrderResponseSchema.parse(tampered.body);
    expect(created.order.totals.total).toBe(1798);
    expect(created.order.paymentStatus).toBe('cod_pending');
    expect(created.payment.action).toBeNull();
  });

  it('is idempotent: a retried submit returns the same order and reserves stock once', async () => {
    await client.post('/cart/items', { variantId: 'p6-m', quantity: 1 });
    const idem = key();
    const first = await client.post('/orders', orderBody(), { 'Idempotency-Key': idem });
    const second = await client.post('/orders', orderBody(), { 'Idempotency-Key': idem });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.order.id).toBe(first.body.order.id);
    await client.signInAdmin();
    expect(orderListSchema.parse((await client.get('/admin/orders')).body).items.filter(order => order.id === first.body.order.id)).toHaveLength(1);
    // Same key with a different payload is rejected rather than silently creating something else.
    await client.post('/cart/items', { variantId: 'p6-m', quantity: 1 });
    const reuse = await client.post('/orders', { ...orderBody(), paymentMethod: 'upi' }, { 'Idempotency-Key': idem });
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('idempotency_key_reuse');
  });

  it('validates the order request (terms, phone, pincode) with field errors', async () => {
    await client.post('/cart/items', { variantId: 'p1-m', quantity: 1 });
    const bad = await client.post('/orders', { ...orderBody(), acceptedTerms: false, contact: { ...contact, phone: '12345' }, shippingAddress: { ...address, pincode: '12' } }, { 'Idempotency-Key': key() });
    expect(bad.status).toBe(422);
    expect(Object.keys(apiErrorBodySchema.parse(bad.body).error.fieldErrors ?? {})).toEqual(expect.arrayContaining(['acceptedTerms', 'contact', 'shippingAddress']));
  });

  it('refuses an empty cart and decrements stock only for real orders', async () => {
    expect((await client.post('/orders', orderBody(), { 'Idempotency-Key': key() })).body.error.code).toBe('cart_empty');
    const before = (await client.get('/inventory/availability?variantIds=p12-m')).body.items[0].availability.status;
    expect(before).toBe('low_stock');
    await client.post('/cart/items', { variantId: 'p12-m', quantity: 2 });
    await client.post('/orders', orderBody(), { 'Idempotency-Key': key() });
    expect((await client.get('/inventory/availability?variantIds=p12-m')).body.items[0].availability.status).toBe('out_of_stock');
    expect(cartSchema.parse((await client.get('/cart')).body).lines).toEqual([]);
  });

  it('only marks an online order paid after the server verifies the outcome; failures restock', async () => {
    await client.post('/cart/items', { variantId: 'p12-l', quantity: 2 });
    const created = createOrderResponseSchema.parse((await client.post('/orders', orderBody('upi'), { 'Idempotency-Key': key() })).body);
    expect(created.order.paymentStatus).toBe('pending');
    expect(created.order.status).toBe('pending_payment');
    expect(created.payment.action).toMatchObject({ type: 'sdk', provider: 'mock-gateway' });

    // access control on the order: token or owner only
    expect((await client.get(`/orders/${created.order.id}`)).status).toBe(404);
    expect((await client.get(`/orders/${created.order.id}?token=wrong`)).status).toBe(404);
    expect(orderSchema.parse((await client.get(`/orders/${created.order.id}?token=${created.lookupToken}`)).body).paymentStatus).toBe('pending');

    const failed = await client.post(`/payments/${created.payment.id}/verify`, { payload: { outcome: 'failure' } });
    expect(failed.body.status).toBe('failed');
    expect((await client.get(`/orders/${created.order.id}?token=${created.lookupToken}`)).body.status).toBe('cancelled');
    expect((await client.get('/inventory/availability?variantIds=p12-l')).body.items[0].availability.status).toBe('low_stock'); // restocked

    await client.post('/cart/items', { variantId: 'p12-l', quantity: 1 });
    const second = createOrderResponseSchema.parse((await client.post('/orders', orderBody('card'), { 'Idempotency-Key': key() })).body);
    await client.post(`/payments/${second.payment.id}/verify`, { payload: { outcome: 'success' } });
    const paid = orderSchema.parse((await client.get(`/orders/${second.order.id}?token=${second.lookupToken}`)).body);
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.status).toBe('confirmed');
    // a settled payment cannot be flipped afterwards
    await client.post(`/payments/${second.payment.id}/verify`, { payload: { outcome: 'failure' } });
    expect((await client.get(`/orders/${second.order.id}?token=${second.lookupToken}`)).body.paymentStatus).toBe('paid');
  });
});

describe('CSRF and environment guards', () => {
  it('rejects writes without a matching CSRF token', async () => {
    const none = await client.request('POST', '/newsletter/subscriptions', { email: 'a@b.co', consent: true }, {}, { csrf: false });
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('csrf_invalid');
    client.jar.set('o218_csrf', 'cookie-value-0123456789abcdef');
    const mismatch = await client.request('POST', '/newsletter/subscriptions', { email: 'a@b.co', consent: true }, { 'X-CSRF-Token': 'something-else-0123456789abcdef' }, { csrf: false });
    expect(mismatch.status).toBe(403);
    const ok = await client.post('/newsletter/subscriptions', { email: 'a@b.co', consent: true });
    expect(ok.status).toBe(202);
    expect(ok.body.status).toBe('pending_confirmation');
  });

  it('sets HttpOnly cookies', async () => {
    const response = await handleMockRequest(new Request('http://localhost/api/v1/csrf-token'));
    expect(response.headers.getSetCookie().join(';')).toMatch(/HttpOnly/);
  });

  it('serves nothing when mock mode is off', async () => {
    process.env.API_MODE = 'live';
    process.env.API_BASE_URL = 'https://api.shop.in/v1';
    resetServerEnvCache();
    const response = await handleMockRequest(new Request('http://localhost/api/v1/products'));
    expect(response.status).toBe(404);
    for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
    delete process.env.API_BASE_URL;
    resetServerEnvCache();
  });
});

describe('customer authentication (development OTP)', () => {
  it('rejects wrong codes, rate-limits guessing and signs in with the configured code', async () => {
    const requested = await client.post('/auth/otp/request', { phone: '9876543210' });
    const { requestId } = requested.body;
    const wrong = await client.post('/auth/otp/verify', { requestId, phone: '9876543210', otp: '000000' });
    expect(wrong.status).toBe(422);
    expect((await client.get('/me')).status).toBe(401);
    for (let attempt = 0; attempt < 5; attempt++) await client.post('/auth/otp/verify', { requestId, phone: '9876543210', otp: '111111' });
    const limited = await client.post('/auth/otp/verify', { requestId, phone: '9876543210', otp: TEST_ENV.MOCK_OTP_CODE });
    expect([422, 429]).toContain(limited.status);

    const session = await client.signInCustomer();
    expect(session.status).toBe(200);
    expect((await client.get('/me')).body.phone).toBe('9876543210');
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect((await client.get('/me')).status).toBe(401);
  });

  it('validates Indian mobile numbers', async () => {
    expect((await client.post('/auth/otp/request', { phone: '1234567890' })).status).toBe(422);
    expect((await client.post('/auth/otp/request', { phone: '98765' })).status).toBe(422);
  });

  it('lets customers see their own orders only', async () => {
    await client.signInCustomer('9123456780');
    await client.post('/cart/items', { variantId: 'p1-m', quantity: 1 });
    const created = await client.post('/orders', orderBody(), { 'Idempotency-Key': 'own-order-key-123456' });
    const mine = orderListSchema.parse((await client.get('/me/orders')).body);
    expect(mine.items.map(order => order.id)).toEqual([created.body.order.id]);
    expect((await client.get(`/orders/${created.body.order.id}`)).status).toBe(200); // owner, no token
    const stranger = new MockClient();
    await stranger.signInCustomer('9000000001');
    expect((await stranger.get(`/orders/${created.body.order.id}`)).status).toBe(404);
  });
});

describe('reviews', () => {
  it('require a signed-in customer and appear only after moderation', async () => {
    const review = { rating: 5, title: 'Great', body: 'Fits perfectly and feels premium.', authorName: 'Asha' };
    expect((await client.post('/products/essential-box-fit-tee-black/reviews', review)).status).toBe(401);
    await client.signInCustomer();
    const created = await client.post('/products/essential-box-fit-tee-black/reviews', review);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    const before = reviewListSchema.parse((await client.get('/products/essential-box-fit-tee-black/reviews')).body);
    expect(before.items.some(item => item.title === 'Great')).toBe(false);

    const admin = new MockClient();
    await admin.signInAdmin();
    expect((await admin.patch(`/admin/reviews/${created.body.id}`, { status: 'published' })).status).toBe(200);
    const after = reviewListSchema.parse((await client.get('/products/essential-box-fit-tee-black/reviews')).body);
    expect(after.items.some(item => item.title === 'Great')).toBe(true);
    expect(after.summary.count).toBe(before.summary.count + 1);
    expect(after.summary.distribution['5']).toBe(before.summary.distribution['5'] + 1);
  });

  it('rejects too-short or oversized reviews', async () => {
    await client.signInCustomer();
    expect((await client.post('/products/essential-box-fit-tee-black/reviews', { rating: 5, title: 'x', body: 'short', authorName: 'A' })).status).toBe(422);
    expect((await client.post('/products/essential-box-fit-tee-black/reviews', { rating: 9, title: 'x', body: 'long enough body here', authorName: 'A' })).status).toBe(422);
  });
});

describe('admin API', () => {
  it('requires authentication for every admin route', async () => {
    for (const path of ['/admin/products', '/admin/orders', '/admin/reviews', '/admin/leads', '/admin/content', '/admin/dashboard/summary', '/admin/categories', '/admin/auth/me', '/admin/orders/export.csv']) {
      expect((await client.get(path)).status, path).toBe(401);
    }
    expect((await client.put('/admin/content/settings', {})).status).toBe(401);
  });

  it('has no built-in credentials, rejects bad logins and locks out brute force', async () => {
    const wrong = await client.post('/admin/auth/login', { email: TEST_ENV.MOCK_ADMIN_EMAIL, password: 'admin' });
    expect(wrong.status).toBe(401);
    expect((await client.post('/admin/auth/login', { email: 'admin@one2oneight.com', password: '1218admin' })).status).toBe(401);
    for (let attempt = 0; attempt < 5; attempt++) await client.post('/admin/auth/login', { email: TEST_ENV.MOCK_ADMIN_EMAIL, password: `guess-${attempt}` });
    expect((await client.signInAdmin()).status).toBe(429);
  });

  it('refuses to log anyone in when mock admin credentials are not configured', async () => {
    delete process.env.MOCK_ADMIN_PASSWORD;
    resetServerEnvCache();
    const response = await client.post('/admin/auth/login', { email: TEST_ENV.MOCK_ADMIN_EMAIL, password: 'whatever-long' });
    expect(response.status).toBe(503);
  });

  it('manages the catalogue with validation, unique slugs and order protection', async () => {
    await client.signInAdmin();
    const me = await client.get('/admin/auth/me');
    expect(me.body.admin.role).toBe('owner');
    const categories = (await client.get('/admin/categories')).body.items;
    const input = {
      name: 'Test Tee', slug: 'test-tee', categoryId: categories[0].id, price: 799, compareAt: 999, color: 'Blue', colorHex: '#112233', badge: null,
      images: ['/images/products/black-tee-front.webp'], fit: 'Regular', material: 'Cotton', description: 'A test product.', bestSeller: false, newArrival: true, luxe: false,
      status: 'active', variants: [{ size: 'M', stock: 5 }, { size: 'L', stock: 0 }],
    };
    const created = await client.post('/admin/products', input);
    expect(created.status).toBe(201);
    expect((await client.post('/admin/products', input)).body.error.code).toBe('slug_taken');
    expect((await client.post('/admin/products', { ...input, slug: 'x', images: ['javascript:alert(1)'] })).status).toBe(422);
    expect((await client.post('/admin/products', { ...input, slug: 'y', price: -5 })).status).toBe(422);
    expect((await client.get('/products/test-tee')).status).toBe(200);
    expect((await client.delete(`/admin/products/${created.body.id}`)).status).toBe(204);
    expect((await client.get('/products/test-tee')).status).toBe(404);

    const guarded = await client.delete('/admin/products/p1'); // appears in a seed order
    expect(guarded.status).toBe(409);
    expect(guarded.body.error.code).toBe('product_has_orders');
  });

  it('keeps category slugs stable when a category is renamed', async () => {
    await client.signInAdmin();
    const [first] = (await client.get('/admin/categories')).body.items;
    const renamed = await client.put(`/admin/categories/${first.id}`, { name: 'Renamed Tees', image: first.image, active: true });
    expect(categorySchema.parse(renamed.body).slug).toBe(first.slug);
    expect(productListSchema.parse((await client.get(`/products?category=${first.slug}`)).body).items.length).toBeGreaterThan(0);
  });

  it('cancelling an order releases its stock; payment status is not editable', async () => {
    await client.post('/cart/items', { variantId: 'p12-s', quantity: 3 });
    const created = await client.post('/orders', orderBody(), { 'Idempotency-Key': 'cancel-order-key-123456' });
    expect((await client.get('/inventory/availability?variantIds=p12-s')).body.items[0].availability.status).toBe('out_of_stock');
    const admin = new MockClient();
    await admin.signInAdmin();
    expect((await admin.patch(`/admin/orders/${created.body.order.id}/status`, { status: 'cancelled' })).status).toBe(200);
    expect((await client.get('/inventory/availability?variantIds=p12-s')).body.items[0].availability.status).toBe('low_stock');
    expect((await admin.patch(`/admin/orders/${created.body.order.id}/status`, { status: 'delivered', paymentStatus: 'paid' })).body.paymentStatus).toBe('cod_pending');
    expect((await admin.patch(`/admin/orders/${created.body.order.id}/status`, { status: 'teleported' })).status).toBe(422);
  });

  it('reports real dashboard numbers (no fabricated deltas)', async () => {
    await client.signInAdmin();
    const summary = dashboardSummarySchema.parse((await client.get('/admin/dashboard/summary')).body);
    expect(summary.orderCount).toBe(3);
    expect(summary.orderCountDeltaPercent).toBeNull();
    expect(summary.revenueDeltaPercent).toBeNull();
    expect(summary.revenueSeries).toHaveLength(7);
  });

  it('stores leads and exports them as formula-safe CSV', async () => {
    const lead = { name: '=cmd|calc', email: 'buyer@example.org', phone: '9876543210', type: 'Bulk purchase', quantity: '50–100 pieces', message: '@SUM(1+1)' };
    expect((await client.post('/leads', lead)).status).toBe(201);
    expect((await client.post('/leads', { ...lead, email: 'not-an-email' })).status).toBe(422);
    await client.signInAdmin();
    expect(adminLeadListSchema.parse((await client.get('/admin/leads')).body).items).toHaveLength(1);
    const exported = await client.get('/admin/leads/export.csv');
    expect(exported.headers.get('content-type')).toContain('text/csv');
    expect(String(exported.body)).toContain("'=cmd|calc");
    expect(String(exported.body)).toContain("'@SUM(1+1)");
  });

  it('updates settings and hero slides with validation (no javascript: links or images)', async () => {
    await client.signInAdmin();
    const content = (await client.get('/admin/content')).body;
    const saved = await client.put('/admin/content/settings', { ...content.settings, brandLine: 'New line' });
    expect(saved.body.brandLine).toBe('New line');
    expect((await client.get('/content/storefront')).body.settings.brandLine).toBe('New line');
    expect((await client.put('/admin/content/settings', { ...content.settings, contactEmail: 'nope' })).status).toBe(422);
    const slide = content.heroSlides[0];
    const { id, ...body } = slide;
    expect((await client.put(`/admin/content/hero-slides/${id}`, { ...body, href: 'https://evil.com' })).status).toBe(422);
    expect((await client.put(`/admin/content/hero-slides/${id}`, { ...body, desktopImage: 'javascript:alert(1)' })).status).toBe(422);
    expect((await client.put(`/admin/content/hero-slides/${id}`, { ...body, title: 'Edited' })).status).toBe(200);
  });
});
