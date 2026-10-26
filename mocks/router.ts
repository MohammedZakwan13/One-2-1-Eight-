/**
 * HTTP layer of the in-memory mock backend (DEVELOPMENT / TEST ONLY – see mocks/store.ts).
 * Route table mirrors openapi/openapi.yaml; `tests/unit/openapi-contract.test.ts` enforces that.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getServerEnv } from '@/lib/env';
import {
  addCartItemSchema, adminCategoryUpdateSchema, adminHeroSlideUpdateSchema, adminLoginRequestSchema, adminProductInputSchema, applyCouponSchema,
  bulkFlagRequestSchema, createOrderRequestSchema, createReviewRequestSchema, leadRequestSchema, newsletterRequestSchema, otpRequestSchema, otpVerifySchema,
  storeSettingsSchema, updateCartItemSchema, updateLeadStatusSchema, updateOrderStatusSchema, updateReviewStatusSchema, verifyPaymentRequestSchema, phoneSchema, pincodeSchema,
} from '@/lib/api/schemas';
import {
  HttpError, applyCoupon, availabilityFor, createOrderFromCart, csvCell, findVariant, getOrCreateCart, getState, listCollections, paymentFor, priceCart,
  queryProducts, resetState, restockOrder, reviewStats, toAdminProduct, toAdminReview, toPublicOrder, toPublicProduct, writeProduct,
  type MockState, type OrderRecord,
} from '@/mocks/store';

const CSRF_COOKIE = 'o218_csrf';
const CART_COOKIE = 'o218_cart';
const SESSION_COOKIE = 'o218_session';

type Ctx = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: MockState;
  cookies: Record<string, string>;
  setCookie: (name: string, value: string, maxAgeSeconds?: number) => void;
  body: <S extends z.ZodType>(schema: S) => Promise<z.infer<S>>;
};
type Result = Response | object | null | undefined;
type Handler = (ctx: Ctx) => Result | Promise<Result>;
type Route = { method: string; pattern: string; regex: RegExp; keys: string[]; handler: Handler; public?: boolean };

const routes: Route[] = [];
const compile = (pattern: string) => {
  const keys: string[] = [];
  const source = pattern.replace(/\/:([A-Za-z]+)/g, (_m, key: string) => { keys.push(key); return '/([^/]+)'; });
  return { regex: new RegExp(`^${source}$`), keys };
};
function route(method: string, pattern: string, handler: Handler) {
  routes.push({ method, pattern, handler, ...compile(pattern) });
}
/** Exposed for the contract test. */
export const mockRoutes = () => routes.map(item => ({ method: item.method, path: item.pattern }));

// ───────────────────────── helpers ─────────────────────────

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const parseCookies = (header: string | null) => {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
};

const sha = (value: string) => createHash('sha256').update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

function requireCustomer(ctx: Ctx) {
  const customerId = ctx.cookies[SESSION_COOKIE] ? ctx.state.customerSessions.get(ctx.cookies[SESSION_COOKIE]) : undefined;
  const customer = ctx.state.customers.find(item => item.id === customerId);
  if (!customer) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.');
  return customer;
}
function currentCustomer(ctx: Ctx) {
  const customerId = ctx.cookies[SESSION_COOKIE] ? ctx.state.customerSessions.get(ctx.cookies[SESSION_COOKIE]) : undefined;
  return ctx.state.customers.find(item => item.id === customerId) ?? null;
}
function requireAdmin(ctx: Ctx) {
  const env = getServerEnv();
  const token = ctx.cookies[env.adminSessionCookie];
  if (!token || !ctx.state.adminSessions.has(token)) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.');
  return { id: 'mock-admin', email: env.mockAdmin?.email ?? 'admin@localhost.invalid', name: 'Mock Admin', role: 'owner' as const };
}

const pageParams = (url: URL, defaultSize = 48) => {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize')) || defaultSize));
  return { page, pageSize };
};
const paginate = <T,>(items: T[], url: URL) => {
  const { page, pageSize } = pageParams(url);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
};
const csv = (filename: string, rows: unknown[][]) =>
  new Response(rows.map(row => row.map(csvCell).join(',')).join('\r\n'), {
    status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
  });

// ───────────────────────── public routes ─────────────────────────

route('GET', '/health', () => ({ status: 'ok' }));

route('GET', '/csrf-token', ctx => {
  const token = ctx.cookies[CSRF_COOKIE] || randomBytes(24).toString('hex');
  ctx.setCookie(CSRF_COOKIE, token, 60 * 60 * 8);
  return { token };
});

route('GET', '/products', ({ url, state }) => {
  const { page, pageSize } = pageParams(url);
  const ids = url.searchParams.get('ids');
  return queryProducts(state, {
    category: url.searchParams.get('category') ?? undefined, collection: url.searchParams.get('collection') ?? undefined, q: url.searchParams.get('q')?.slice(0, 100) || undefined,
    ids: ids ? ids.split(',').filter(Boolean).slice(0, 100) : undefined, sort: url.searchParams.get('sort') ?? undefined, page, pageSize,
  });
});

const activeBySlug = (state: MockState, slug: string) => {
  const product = state.products.find(item => item.slug === slug && item.status === 'active');
  if (!product) throw new HttpError(404, 'not_found', 'Product not found.');
  return product;
};
route('GET', '/products/:slug', ({ state, params }) => toPublicProduct(state, activeBySlug(state, params.slug)));
route('GET', '/products/:slug/related', ({ state, params, url }) => {
  const product = activeBySlug(state, params.slug);
  const limit = Math.min(12, Math.max(1, Number(url.searchParams.get('limit')) || 4));
  const others = state.products.filter(item => item.status === 'active' && item.id !== product.id);
  const related = others.filter(item => item.categoryId === product.categoryId || (product.luxe && item.luxe));
  const items = (related.length ? related : others).slice(0, limit).map(item => toPublicProduct(state, item));
  return { items, total: items.length, page: 1, pageSize: limit };
});
route('GET', '/products/:slug/reviews', ({ state, params }) => {
  const product = activeBySlug(state, params.slug);
  const stats = reviewStats(state, product.id);
  const items = stats.published.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(review => ({
    id: review.id, author: review.author, rating: review.rating, title: review.title, body: review.body, createdAt: review.createdAt, verifiedPurchase: review.verifiedPurchase,
  }));
  return { summary: { average: stats.average, count: stats.count, distribution: stats.distribution }, items };
});
route('POST', '/products/:slug/reviews', async ctx => {
  const customer = requireCustomer(ctx);
  const product = activeBySlug(ctx.state, ctx.params.slug);
  const input = await ctx.body(createReviewRequestSchema);
  const purchased = ctx.state.orders.some(order => order.customerId === customer.id && order.lines.some(line => line.productId === product.id));
  const review = { id: `rev_${randomUUID().slice(0, 8)}`, productId: product.id, author: customer.name || input.authorName, rating: input.rating, title: input.title, body: input.body, status: 'pending' as const, createdAt: new Date().toISOString(), verifiedPurchase: purchased, customerId: customer.id };
  ctx.state.reviews.unshift(review);
  return json({ id: review.id, status: 'pending', message: 'Thank you — your review will appear once it has been moderated.' }, 201);
});

route('GET', '/categories', ({ state }) => ({ items: state.categories.filter(category => category.active) }));
route('GET', '/collections', () => ({ items: listCollections() }));

route('GET', '/inventory/availability', ({ state, url }) => {
  const ids = (url.searchParams.get('variantIds') ?? '').split(',').filter(Boolean).slice(0, 100);
  return { items: ids.flatMap(id => { const found = findVariant(state, id); return found ? [{ variantId: id, sku: found.variant.sku, availability: availabilityFor(found.variant.stock) }] : []; }) };
});

route('GET', '/serviceability', ({ url }) => {
  const parsed = pincodeSchema.safeParse(url.searchParams.get('pincode'));
  if (!parsed.success) throw new HttpError(422, 'validation_failed', 'Enter a valid 6-digit pincode.', { pincode: ['Enter a valid 6-digit pincode'] });
  const pincode = parsed.data;
  // Deterministic development rule: pincodes starting with 9 are "not serviceable".
  if (pincode.startsWith('9')) return { pincode, serviceable: false, codAvailable: false, estimatedDays: null, message: 'We do not deliver to this pincode yet (development rule).' };
  return { pincode, serviceable: true, codAvailable: !pincode.startsWith('8'), estimatedDays: { min: 3, max: 5 }, message: null };
});

route('GET', '/content/storefront', ({ state }) => ({ settings: state.settings, heroSlides: state.heroSlides.filter(slide => slide.active), categories: state.categories.filter(category => category.active) }));
route('GET', '/content/pages/:slug', ({ params }) => {
  // The mock deliberately ships no legal copy – real policies must come from the CMS.
  if (params.slug === 'size-guide-notes') return { slug: params.slug, title: 'Size notes', body: 'Development-only page.', updatedAt: new Date().toISOString() };
  throw new HttpError(404, 'not_found', 'Page not found.');
});

// cart
const cartFor = (ctx: Ctx) => {
  const { cart, created } = getOrCreateCart(ctx.state, ctx.cookies[CART_COOKIE] ?? null);
  if (created) ctx.setCookie(CART_COOKIE, cart.id, 60 * 60 * 24 * 30);
  return cart;
};
route('GET', '/cart', ctx => priceCart(ctx.state, cartFor(ctx)));
route('POST', '/cart/items', async ctx => {
  const cart = cartFor(ctx);
  const { variantId, quantity } = await ctx.body(addCartItemSchema);
  const found = findVariant(ctx.state, variantId);
  if (!found || found.product.status !== 'active') throw new HttpError(404, 'not_found', 'That item is no longer available.');
  if (found.variant.stock <= 0) throw new HttpError(409, 'out_of_stock', 'Sorry, that size is out of stock.');
  const existing = cart.lines.find(line => line.variantId === variantId);
  const desired = (existing?.quantity ?? 0) + quantity;
  const capped = Math.min(desired, found.variant.stock, 20);
  if (existing) existing.quantity = capped; else cart.lines.push({ id: `line_${randomUUID().slice(0, 8)}`, variantId, quantity: capped });
  const priced = priceCart(ctx.state, cart);
  if (capped < desired) priced.messages.push(`Only ${capped} available for ${found.product.name} (${found.variant.size}).`);
  return priced;
});
route('PATCH', '/cart/items/:id', async ctx => {
  const cart = cartFor(ctx);
  const { quantity } = await ctx.body(updateCartItemSchema);
  const line = cart.lines.find(item => item.id === ctx.params.id);
  if (!line) throw new HttpError(404, 'not_found', 'That item is not in your bag.');
  if (quantity === 0) cart.lines = cart.lines.filter(item => item.id !== line.id);
  else line.quantity = quantity;
  return priceCart(ctx.state, cart);
});
route('DELETE', '/cart/items/:id', ctx => {
  const cart = cartFor(ctx);
  cart.lines = cart.lines.filter(item => item.id !== ctx.params.id);
  return priceCart(ctx.state, cart);
});
route('PUT', '/cart/coupon', async ctx => {
  const cart = cartFor(ctx);
  const { code } = await ctx.body(applyCouponSchema);
  applyCoupon(ctx.state, cart, code);
  return priceCart(ctx.state, cart);
});
route('DELETE', '/cart/coupon', ctx => {
  const cart = cartFor(ctx);
  cart.couponCode = null;
  return priceCart(ctx.state, cart);
});

// orders & payments
route('POST', '/orders', async ctx => {
  const key = ctx.req.headers.get('idempotency-key');
  if (!key || key.length < 8) throw new HttpError(400, 'idempotency_key_required', 'An Idempotency-Key header is required.');
  const input = await ctx.body(createOrderRequestSchema);
  const cart = cartFor(ctx);
  const fingerprint = JSON.stringify({ input, cart: cart.id });
  const prior = ctx.state.idempotency.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new HttpError(422, 'idempotency_key_reuse', 'That Idempotency-Key was already used for a different request.');
    return json(prior.response, 200);
  }
  const customer = currentCustomer(ctx);
  const order = createOrderFromCart(ctx.state, cart, input, customer?.id ?? null);
  const response = {
    order: toPublicOrder(order),
    payment: { ...paymentFor(order), action: order.paymentMethod === 'cod' ? null : { type: 'sdk' as const, provider: 'mock-gateway', payload: { paymentId: order.paymentId, orderId: order.id } } },
    lookupToken: order.lookupToken,
  };
  ctx.state.idempotency.set(key, { fingerprint, response });
  return json(response, 201);
});

const orderAccess = (ctx: Ctx, order: OrderRecord) => {
  const token = ctx.url.searchParams.get('token');
  const customer = currentCustomer(ctx);
  const byToken = Boolean(token) && safeEqual(token!, order.lookupToken);
  const byCustomer = Boolean(customer) && order.customerId === customer!.id;
  if (!byToken && !byCustomer) throw new HttpError(404, 'not_found', 'Order not found.');
};
route('GET', '/orders/:id', ctx => {
  const order = ctx.state.orders.find(item => item.id === ctx.params.id);
  if (!order) throw new HttpError(404, 'not_found', 'Order not found.');
  orderAccess(ctx, order);
  return toPublicOrder(order);
});
route('POST', '/payments/:id/verify', async ctx => {
  const order = ctx.state.orders.find(item => item.paymentId === ctx.params.id);
  if (!order) throw new HttpError(404, 'not_found', 'Payment not found.');
  const { payload } = await ctx.body(verifyPaymentRequestSchema);
  if (order.paymentStatus !== 'pending') return paymentFor(order);
  if (payload.outcome === 'success') { order.paymentStatus = 'paid'; order.status = 'confirmed'; }
  else { order.paymentStatus = 'failed'; order.status = 'cancelled'; restockOrder(ctx.state, order); }
  return { ...paymentFor(order), action: null };
});
route('GET', '/me/orders', ctx => {
  const customer = requireCustomer(ctx);
  return paginate(ctx.state.orders.filter(order => order.customerId === customer.id).map(toPublicOrder), ctx.url);
});

// customer auth (development OTP)
route('POST', '/auth/otp/request', async ctx => {
  const { phone } = await ctx.body(otpRequestSchema);
  const requestId = `otp_${randomUUID()}`;
  ctx.state.otpRequests.set(requestId, { phone, attempts: 0, expiresAt: Date.now() + 5 * 60_000 });
  return json({ requestId, expiresInSeconds: 300, resendAfterSeconds: 30 });
});
route('POST', '/auth/otp/verify', async ctx => {
  const env = getServerEnv();
  const input = await ctx.body(otpVerifySchema);
  if (!env.mockOtpCode) throw new HttpError(503, 'mock_otp_not_configured', 'Set MOCK_OTP_CODE to enable development sign-in.');
  const request = ctx.state.otpRequests.get(input.requestId);
  if (!request || request.phone !== input.phone || request.expiresAt < Date.now()) throw new HttpError(422, 'otp_invalid', 'That code has expired. Request a new one.');
  request.attempts += 1;
  if (request.attempts > 5) { ctx.state.otpRequests.delete(input.requestId); throw new HttpError(429, 'rate_limited', 'Too many attempts. Request a new code.'); }
  if (!safeEqual(input.otp, env.mockOtpCode)) throw new HttpError(422, 'otp_invalid', 'That code is not correct.');
  ctx.state.otpRequests.delete(input.requestId);
  let customer = ctx.state.customers.find(item => item.phone === input.phone);
  if (!customer) { customer = { id: `cus_${randomUUID().slice(0, 8)}`, phone: input.phone, name: null, email: null }; ctx.state.customers.push(customer); }
  const session = randomBytes(24).toString('hex');
  ctx.state.customerSessions.set(session, customer.id);
  ctx.setCookie(SESSION_COOKIE, session, 60 * 60 * 24 * 7);
  return { customer };
});
route('POST', '/auth/logout', ctx => {
  if (ctx.cookies[SESSION_COOKIE]) ctx.state.customerSessions.delete(ctx.cookies[SESSION_COOKIE]);
  ctx.setCookie(SESSION_COOKIE, '', 0);
  return null;
});
route('GET', '/me', ctx => requireCustomer(ctx));

route('POST', '/newsletter/subscriptions', async ctx => {
  const { email } = await ctx.body(newsletterRequestSchema);
  ctx.state.subscriptions.add(email);
  return json({ status: 'pending_confirmation' }, 202);
});
route('POST', '/leads', async ctx => {
  const input = await ctx.body(leadRequestSchema);
  const lead = { id: `lead_${randomUUID().slice(0, 8)}`, ...input, status: 'new' as const, createdAt: new Date().toISOString() };
  ctx.state.leads.unshift(lead);
  return json({ id: lead.id }, 201);
});

// ───────────────────────── admin routes ─────────────────────────

route('POST', '/admin/auth/login', async ctx => {
  const env = getServerEnv();
  const { email, password } = await ctx.body(adminLoginRequestSchema);
  if (!env.mockAdmin) throw new HttpError(503, 'mock_admin_not_configured', 'Set MOCK_ADMIN_EMAIL and MOCK_ADMIN_PASSWORD to enable the development admin account.');
  const key = email.toLowerCase();
  if ((ctx.state.failedLogins.get(key) ?? 0) >= 5) throw new HttpError(429, 'rate_limited', 'Too many failed attempts. Try again later.');
  if (!(safeEqual(email.toLowerCase(), env.mockAdmin.email.toLowerCase()) && safeEqual(password, env.mockAdmin.password))) {
    ctx.state.failedLogins.set(key, (ctx.state.failedLogins.get(key) ?? 0) + 1);
    throw new HttpError(401, 'invalid_credentials', 'That email and password did not match.');
  }
  ctx.state.failedLogins.delete(key);
  const token = randomBytes(32).toString('hex');
  ctx.state.adminSessions.add(token);
  ctx.setCookie(env.adminSessionCookie, token, 60 * 60 * 8);
  return { mfaRequired: false, admin: { id: 'mock-admin', email: env.mockAdmin.email, name: 'Mock Admin', role: 'owner' } };
});
route('POST', '/admin/auth/mfa', () => { throw new HttpError(400, 'mfa_not_enabled', 'MFA is not enabled in the development mock.'); });
route('POST', '/admin/auth/logout', ctx => {
  const env = getServerEnv();
  const token = ctx.cookies[env.adminSessionCookie];
  if (token) ctx.state.adminSessions.delete(token);
  ctx.setCookie(env.adminSessionCookie, '', 0);
  return null;
});
route('GET', '/admin/auth/me', ctx => ({ admin: requireAdmin(ctx) }));

route('GET', '/admin/dashboard/summary', ctx => {
  requireAdmin(ctx);
  const { state } = ctx;
  const counted = state.orders.filter(order => order.status !== 'cancelled' && order.status !== 'refunded');
  const series = new Map<string, number>();
  for (let index = 6; index >= 0; index--) series.set(new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10), 0);
  for (const order of counted) { const day = order.createdAt.slice(0, 10); if (series.has(day)) series.set(day, (series.get(day) ?? 0) + order.totals.total); }
  return {
    orderCount: state.orders.length, grossRevenue: counted.reduce((sum, order) => sum + order.totals.total, 0), productCount: state.products.length,
    lowStockCount: state.products.filter(product => product.variants.some(variant => variant.stock <= 5)).length,
    newArrivalCount: state.products.filter(product => product.newArrival && product.status === 'active').length,
    newLeadCount: state.leads.filter(lead => lead.status === 'new').length, pendingReviewCount: state.reviews.filter(review => review.status === 'pending').length,
    orderCountDeltaPercent: null, revenueDeltaPercent: null,
    revenueSeries: [...series.entries()].map(([date, amount]) => ({ date, amount })),
    recentOrders: state.orders.slice(0, 5).map(toPublicOrder),
  };
});

route('GET', '/admin/products', ctx => { requireAdmin(ctx); return paginate(ctx.state.products.map(product => toAdminProduct(ctx.state, product)), ctx.url); });
route('POST', '/admin/products/bulk-flags', async ctx => {
  requireAdmin(ctx);
  const { flag, value } = await ctx.body(bulkFlagRequestSchema);
  for (const product of ctx.state.products) product[flag] = value;
  return null;
});
route('POST', '/admin/products', async ctx => {
  requireAdmin(ctx);
  const input = await ctx.body(adminProductInputSchema);
  const record = writeProduct(ctx.state, input);
  ctx.state.products.unshift(record);
  return json(toAdminProduct(ctx.state, record), 201);
});
route('PUT', '/admin/products/:id', async ctx => {
  requireAdmin(ctx);
  const index = ctx.state.products.findIndex(product => product.id === ctx.params.id);
  if (index < 0) throw new HttpError(404, 'not_found', 'Product not found.');
  const input = await ctx.body(adminProductInputSchema);
  ctx.state.products[index] = writeProduct(ctx.state, input, ctx.state.products[index]);
  return toAdminProduct(ctx.state, ctx.state.products[index]);
});
route('DELETE', '/admin/products/:id', ctx => {
  requireAdmin(ctx);
  const product = ctx.state.products.find(item => item.id === ctx.params.id);
  if (!product) throw new HttpError(404, 'not_found', 'Product not found.');
  if (ctx.state.orders.some(order => order.lines.some(line => line.productId === product.id))) throw new HttpError(409, 'product_has_orders', 'This product has orders. Set it to draft instead of deleting it.');
  ctx.state.products = ctx.state.products.filter(item => item.id !== product.id);
  return null;
});

route('GET', '/admin/categories', ctx => { requireAdmin(ctx); return { items: ctx.state.categories }; });
route('PUT', '/admin/categories/:id', async ctx => {
  requireAdmin(ctx);
  const category = ctx.state.categories.find(item => item.id === ctx.params.id);
  if (!category) throw new HttpError(404, 'not_found', 'Category not found.');
  const input = await ctx.body(adminCategoryUpdateSchema);
  // Slug is stable by design: renaming a category must not break URLs or product links.
  Object.assign(category, { name: input.name, image: input.image, active: input.active });
  return category;
});

route('GET', '/admin/orders/export.csv', ctx => {
  requireAdmin(ctx);
  return csv('orders.csv', [['number', 'created_at', 'customer', 'status', 'payment_status', 'payment_method', 'total'], ...ctx.state.orders.map(order => [order.number, order.createdAt, order.contact.name, order.status, order.paymentStatus, order.paymentMethod, order.totals.total])]);
});
route('GET', '/admin/orders', ctx => { requireAdmin(ctx); return paginate(ctx.state.orders.map(toPublicOrder), ctx.url); });
route('PATCH', '/admin/orders/:id/status', async ctx => {
  requireAdmin(ctx);
  const order = ctx.state.orders.find(item => item.id === ctx.params.id);
  if (!order) throw new HttpError(404, 'not_found', 'Order not found.');
  const { status } = await ctx.body(updateOrderStatusSchema);
  if (status === 'cancelled' && order.status !== 'cancelled') restockOrder(ctx.state, order);
  order.status = status;
  return toPublicOrder(order);
});

route('GET', '/admin/reviews', ctx => { requireAdmin(ctx); return paginate(ctx.state.reviews.map(review => toAdminReview(ctx.state, review)), ctx.url); });
route('PATCH', '/admin/reviews/:id', async ctx => {
  requireAdmin(ctx);
  const review = ctx.state.reviews.find(item => item.id === ctx.params.id);
  if (!review) throw new HttpError(404, 'not_found', 'Review not found.');
  review.status = (await ctx.body(updateReviewStatusSchema)).status;
  return toAdminReview(ctx.state, review);
});

route('GET', '/admin/leads/export.csv', ctx => {
  requireAdmin(ctx);
  return csv('leads.csv', [['id', 'created_at', 'name', 'email', 'phone', 'type', 'quantity', 'status', 'message'], ...ctx.state.leads.map(lead => [lead.id, lead.createdAt, lead.name, lead.email, lead.phone, lead.type, lead.quantity, lead.status, lead.message])]);
});
route('GET', '/admin/leads', ctx => { requireAdmin(ctx); return paginate(ctx.state.leads, ctx.url); });
route('PATCH', '/admin/leads/:id', async ctx => {
  requireAdmin(ctx);
  const lead = ctx.state.leads.find(item => item.id === ctx.params.id);
  if (!lead) throw new HttpError(404, 'not_found', 'Enquiry not found.');
  lead.status = (await ctx.body(updateLeadStatusSchema)).status;
  return lead;
});

route('GET', '/admin/content', ctx => { requireAdmin(ctx); return { settings: ctx.state.settings, heroSlides: ctx.state.heroSlides }; });
route('PUT', '/admin/content/settings', async ctx => {
  requireAdmin(ctx);
  ctx.state.settings = await ctx.body(storeSettingsSchema);
  return ctx.state.settings;
});
route('PUT', '/admin/content/hero-slides/:id', async ctx => {
  requireAdmin(ctx);
  const slide = ctx.state.heroSlides.find(item => item.id === ctx.params.id);
  if (!slide) throw new HttpError(404, 'not_found', 'Slide not found.');
  Object.assign(slide, await ctx.body(adminHeroSlideUpdateSchema));
  return slide;
});

// test-only helper (not part of the public contract)
route('POST', '/__mock/reset', () => { resetState(); return null; });

// phone schema is re-exported to keep tree-shaking honest in tests
void phoneSchema;

// ───────────────────────── dispatcher ─────────────────────────

export async function handleMockRequest(req: Request): Promise<Response> {
  const env = getServerEnv();
  if (!env.mockEnabled) return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/v1/, '') || '/';
  const matched = routes.find(item => item.method === req.method && item.regex.test(path));
  if (!matched) {
    const pathKnown = routes.some(item => item.regex.test(path));
    return json({ error: { code: pathKnown ? 'method_not_allowed' : 'not_found', message: pathKnown ? 'Method not allowed.' : 'Not found.' } }, pathKnown ? 405 : 404);
  }
  const match = matched.regex.exec(path)!;
  const params: Record<string, string> = {};
  matched.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1]); });

  const cookies = parseCookies(req.headers.get('cookie'));
  const setCookies: string[] = [];
  const ctx: Ctx = {
    req, url, params, state: getState(), cookies,
    setCookie: (name, value, maxAge = 0) => setCookies.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`),
    body: async schema => {
      let raw: unknown;
      try { raw = await req.json(); } catch { throw new HttpError(400, 'invalid_json', 'The request body must be valid JSON.'); }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new HttpError(422, 'validation_failed', 'Some details need your attention.', z.flattenError(parsed.error as z.ZodError).fieldErrors as Record<string, string[]>);
      }
      return parsed.data;
    },
  };

  try {
    if (req.method !== 'GET' && matched.pattern !== '/__mock/reset') {
      const header = req.headers.get('x-csrf-token');
      if (!header || !cookies[CSRF_COOKIE] || !safeEqual(header, cookies[CSRF_COOKIE])) throw new HttpError(403, 'csrf_invalid', 'Your session expired. Please try again.');
    }
    const result = await matched.handler(ctx);
    const response = result instanceof Response ? result : result == null ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : json(result);
    for (const cookie of setCookies) response.headers.append('Set-Cookie', cookie);
    return response;
  } catch (error) {
    if (error instanceof HttpError) {
      const response = json({ error: { code: error.code, message: error.message, ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) } }, error.status);
      for (const cookie of setCookies) response.headers.append('Set-Cookie', cookie);
      return response;
    }
    console.error('[mock-api] unhandled error', error);
    return json({ error: { code: 'server_error', message: 'Something went wrong.' } }, 500);
  }
}
