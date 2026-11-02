/* eslint-disable @typescript-eslint/no-explicit-any -- database rows are validated by the API schemas at the HTTP boundary */
import 'server-only';
import {
  addCartItemSchema, applyCouponSchema, createOrderRequestSchema, createReviewRequestSchema, leadRequestSchema, newsletterRequestSchema, otpRequestSchema,
  cancelOrderRequestSchema, createReturnRequestSchema, otpVerifySchema, pincodeSchema, savedAddressInputSchema, updateCartItemSchema, verifyPaymentRequestSchema,
} from '@/lib/api/schemas';
import { CUSTOMER_SESSION_SECONDS, currentCustomer, requireCustomer } from '@/lib/backend/auth';
import {
  COOKIES, HttpError, db, imageUrl, isUnique, isUuid, json, must, newToken, pageParams, rateLimit, route, safeEqual, sha256, trackingToken,
} from '@/lib/backend/core';
import {
  MAX_LINE_QUANTITY, ORDER_SELECT, PRODUCT_SELECT, applyCoupon, availability, getSettingsRow, loadOrder, orderMailData, paymentMethods, priceCart, reviewStats, selectRelated,
  toOrder, toProducts, toSettings, type Row,
} from '@/lib/backend/data';
import { isCancellable, presentOrders, trackingUrl } from '@/lib/backend/returns';
import { checkOtpRequest, logOtp, noteRateLimit, noteValidationFailure, requireSameMobile } from '@/lib/backend/otp';
import { createRazorpayOrder, sendLeadEmails, sendOrderEmail, verifyOtpAccessToken, sendReturnEmail, verifyRazorpayPayment } from '@/lib/backend/integrations';
import { getServerEnv } from '@/lib/env';

const COLLECTIONS = [
  { slug: 'best-sellers', title: 'Best sellers', description: 'The pieces customers come back for.' },
  { slug: 'new-arrivals', title: 'New arrivals', description: 'The latest fits and fresh colour stories.' },
  { slug: 'one-2-1-eight-luxe', title: 'ONE 2 1 EIGHT LUXE', description: 'Elevated textures, refined details and quieter statements.' },
  { slug: 'layering-edit', title: 'The layering edit', description: 'Considered layers for every day.' },
];
const LAYERING_CATEGORIES = ['hoodie', 'sweatshirt', 'drop-shoulder'];
const DAY = 86_400;

const categoryDto = (r: Row) => ({ id: r.id, name: r.name, slug: r.slug, image: imageUrl(r.image), active: r.active });
export const heroDto = (r: Row) => ({
  id: r.id, kicker: r.kicker, title: r.title, body: r.body, desktopImage: imageUrl(r.desktop_image), mobileImage: imageUrl(r.mobile_image), cta: r.cta, href: r.href, active: r.active,
});

// ───────────── health ─────────────

route('GET', '/health', () => ({ status: 'ok' }));
route('GET', '/ready', async () => {
  const { error } = await db().from('store_settings').select('id').limit(1);
  if (error) return json({ status: 'unavailable', database: 'unreachable' }, 503);
  return { status: 'ok', database: 'ok' };
});
route('GET', '/csrf-token', ctx => {
  const token = ctx.cookies[COOKIES.csrf] || newToken(24);
  ctx.setCookie(COOKIES.csrf, token, 60 * 60 * 8);
  return { token };
});

// ───────────── catalogue ─────────────

route('GET', '/products', async ({ url }) => {
  const { page, pageSize } = pageParams(url);
  const sp = url.searchParams;
  const settings = await getSettingsRow();
  const categories = must(await db().from('categories').select('id, slug, name'), 'categories') as Row[];
  const sort = sp.get('sort') ?? 'featured';

  let query = db().from('products').select(PRODUCT_SELECT, { count: 'exact' }).eq('status', 'active');
  const ids = (sp.get('ids') ?? '').split(',').filter(isUuid).slice(0, 100);
  if (sp.get('ids')) query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const category = sp.get('category');
  if (category) query = query.eq('category_id', categories.find(c => c.slug === category)?.id ?? '00000000-0000-0000-0000-000000000000');
  const collection = sp.get('collection');
  if (collection) {
    if (collection === 'best-sellers') query = query.eq('best_seller', true);
    else if (collection === 'new-arrivals') query = query.eq('new_arrival', true);
    else if (collection === 'one-2-1-eight-luxe') query = query.eq('luxe', true);
    else if (collection === 'layering-edit') query = query.in('category_id', categories.filter(c => LAYERING_CATEGORIES.includes(c.slug)).map(c => c.id));
    else return { items: [], total: 0, page, pageSize };
  }
  const text = (sp.get('q') ?? '').slice(0, 100).toLowerCase().split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}-]/gu, '')).filter(Boolean);
  for (const raw of text) {
    const token = raw.length > 3 ? raw.replace(/s$/, '') : raw;
    const matchingCategories = categories.filter(c => c.name.toLowerCase().includes(token)).map(c => c.id);
    query = query.or([`name.ilike.%${token}%`, `color.ilike.%${token}%`, `fit.ilike.%${token}%`, ...(matchingCategories.length ? [`category_id.in.(${matchingCategories.join(',')})`] : [])].join(','));
  }

  if (sort === 'rating') {
    const rows = must(await query.limit(500), 'products') as Row[];
    const products = await toProducts(rows, settings);
    products.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
    return { items: products.slice((page - 1) * pageSize, page * pageSize), total: products.length, page, pageSize };
  }
  if (sort === 'price-low') query = query.order('price', { ascending: true });
  else if (sort === 'price-high') query = query.order('price', { ascending: false });
  else if (sort === 'new') query = query.order('new_arrival', { ascending: false }).order('created_at', { ascending: false });
  else query = query.order('best_seller', { ascending: false }).order('created_at', { ascending: false });
  const { data, error, count } = await query.order('id').range((page - 1) * pageSize, page * pageSize - 1);
  if (error) { console.error('[backend] products', error.message); throw new HttpError(500, 'server_error', 'Something went wrong.'); }
  return { items: await toProducts((data ?? []) as Row[], settings), total: count ?? 0, page, pageSize };
});

async function activeProduct(slug: string): Promise<Row> {
  const { data } = await db().from('products').select(PRODUCT_SELECT).eq('slug', slug).eq('status', 'active').maybeSingle();
  if (!data) throw new HttpError(404, 'not_found', 'Product not found.');
  return data;
}

route('GET', '/products/:slug', async ({ params }) => {
  const [row, settings] = await Promise.all([activeProduct(params.slug), getSettingsRow()]);
  return (await toProducts([row], settings))[0];
});

route('GET', '/products/:slug/related', async ({ params, url }) => {
  const product = await activeProduct(params.slug);
  const limit = Math.min(12, Math.max(1, Math.floor(Number(url.searchParams.get('limit'))) || 4));
  const settings = await getSettingsRow();
  const base = () => db().from('products').select(PRODUCT_SELECT).eq('status', 'active').neq('id', product.id);
  const [same, others] = await Promise.all([base().eq('category_id', product.category_id).limit(48), base().order('best_seller', { ascending: false }).order('created_at', { ascending: false }).limit(48)]);
  const rows = selectRelated(product, [...(must(same, 'related') as Row[]), ...(must(others, 'related') as Row[])], limit);
  const items = await toProducts(rows, settings);
  return { items, total: items.length, page: 1, pageSize: limit };
});

route('GET', '/products/:slug/reviews', async ({ params }) => {
  const product = await activeProduct(params.slug);
  const rows = must(await db().from('reviews').select('id, author, rating, title, body, created_at, verified_purchase').eq('product_id', product.id).eq('status', 'published').order('created_at', { ascending: false }), 'reviews') as Row[];
  const stat = (await reviewStats([product.id])).get(product.id);
  return {
    summary: { average: stat ? Math.round((stat.sum / stat.count) * 10) / 10 : 0, count: stat?.count ?? 0, distribution: stat?.distribution ?? { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } },
    items: rows.map(r => ({ id: r.id, author: r.author, rating: r.rating, title: r.title, body: r.body, createdAt: r.created_at, verifiedPurchase: r.verified_purchase })),
  };
});

route('POST', '/products/:slug/reviews', async ctx => {
  const customer = await requireCustomer(ctx);
  const product = await activeProduct(ctx.params.slug);
  const input = await ctx.body(createReviewRequestSchema);
  await rateLimit(`review:${customer.id}`, 5, 3600);
  const { data: purchased } = await db().from('order_items').select('id, orders!inner(customer_id, status)').eq('product_id', product.id).eq('orders.customer_id', customer.id).in('orders.status', ['confirmed', 'processing', 'packed', 'shipped', 'delivered']).limit(1);
  const review = must(await db().from('reviews').insert({
    product_id: product.id, customer_id: customer.id, author: customer.name || input.authorName, rating: input.rating, title: input.title, body: input.body, status: 'pending', verified_purchase: Boolean(purchased?.length),
  }).select('id').single(), 'create review') as Row;
  return json({ id: review.id, status: 'pending', message: 'Thank you — your review will appear once it has been moderated.' }, 201);
});

route('GET', '/categories', async () => ({ items: (must(await db().from('categories').select('*').eq('active', true).order('sort_order'), 'categories') as Row[]).map(categoryDto) }));
route('GET', '/collections', () => ({ items: COLLECTIONS }));

route('GET', '/inventory/availability', async ({ url }) => {
  const ids = (url.searchParams.get('variantIds') ?? '').split(',').filter(isUuid).slice(0, 100);
  if (!ids.length) return { items: [] };
  const settings = await getSettingsRow();
  const rows = must(await db().from('product_variants').select('id, sku, stock, active, products(status)').in('id', ids).eq('active', true), 'availability') as Row[];
  return { items: rows.filter(r => r.products?.status === 'active').map(r => ({ variantId: r.id, sku: r.sku, availability: availability(r.stock, settings.low_stock_threshold) })) };
});

async function pincodeRule(pincode: string) {
  const rules = must(await db().from('pincode_rules').select('*'), 'pincode rules') as Row[];
  return rules.filter(rule => pincode.startsWith(rule.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? null;
}
route('GET', '/serviceability', async ({ url }) => {
  const parsed = pincodeSchema.safeParse(url.searchParams.get('pincode'));
  if (!parsed.success) throw new HttpError(422, 'validation_failed', 'Enter a valid 6-digit pincode.', { pincode: ['Enter a valid 6-digit pincode'] });
  const rule = await pincodeRule(parsed.data);
  if (!rule || !rule.serviceable) return { pincode: parsed.data, serviceable: false, codAvailable: false, estimatedDays: null, message: rule?.message ?? 'We do not deliver to this pincode yet.' };
  return { pincode: parsed.data, serviceable: true, codAvailable: rule.cod_available, estimatedDays: { min: rule.min_days, max: rule.max_days }, message: rule.message };
});

// ───────────── content ─────────────

route('GET', '/content/storefront', async () => {
  const [settings, slides, categories] = await Promise.all([
    getSettingsRow(),
    db().from('hero_slides').select('*').eq('active', true).order('sort_order'),
    db().from('categories').select('*').eq('active', true).order('sort_order'),
  ]);
  return { settings: toSettings(settings), heroSlides: (must(slides, 'hero') as Row[]).map(heroDto), categories: (must(categories, 'categories') as Row[]).map(categoryDto), paymentMethods: paymentMethods() };
});
route('GET', '/content/pages/:slug', async ({ params }) => {
  const { data } = await db().from('legal_pages').select('slug, title, body, updated_at').eq('slug', params.slug).eq('published', true).maybeSingle();
  if (!data) throw new HttpError(404, 'not_found', 'Page not found.');
  return { slug: data.slug, title: data.title, body: data.body, updatedAt: data.updated_at };
});

// ───────────── cart ─────────────

async function cartFor(ctx: { cookies: Record<string, string>; setCookie: (n: string, v: string, s?: number) => void }): Promise<string> {
  const existing = ctx.cookies[COOKIES.cart];
  if (isUuid(existing)) {
    const { data } = await db().from('carts').select('id').eq('id', existing).maybeSingle();
    if (data) return data.id;
  }
  const created = must(await db().from('carts').insert({}).select('id').single(), 'create cart') as Row;
  ctx.setCookie(COOKIES.cart, created.id, 30 * DAY);
  return created.id;
}

route('GET', '/cart', async ctx => (await priceCart(await cartFor(ctx))).cart);

route('POST', '/cart/items', async ctx => {
  const cartId = await cartFor(ctx);
  const { variantId, quantity } = await ctx.body(addCartItemSchema);
  const { data: variant } = await db().from('product_variants').select('id, size, stock, active, products(name, status)').eq('id', variantId).maybeSingle();
  const product = (variant as any)?.products;
  if (!variant || !variant.active || product?.status !== 'active') throw new HttpError(404, 'not_found', 'That item is no longer available.');
  if (variant.stock <= 0) throw new HttpError(409, 'out_of_stock', 'Sorry, that size is out of stock.');
  const { data: existing } = await db().from('cart_items').select('id, quantity').eq('cart_id', cartId).eq('variant_id', variantId).maybeSingle();
  const desired = (existing?.quantity ?? 0) + quantity;
  const capped = Math.min(desired, variant.stock, MAX_LINE_QUANTITY);
  if (existing) must(await db().from('cart_items').update({ quantity: capped }).eq('id', existing.id), 'update cart item');
  else must(await db().from('cart_items').insert({ cart_id: cartId, variant_id: variantId, quantity: capped }), 'add cart item');
  const priced = (await priceCart(cartId)).cart;
  if (capped < desired) priced.messages.push(`Only ${capped} available for ${product.name} (${variant.size}).`);
  return priced;
});

route('PATCH', '/cart/items/:id', async ctx => {
  const cartId = await cartFor(ctx);
  const { quantity } = await ctx.body(updateCartItemSchema);
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'That item is not in your bag.');
  const { data: line } = await db().from('cart_items').select('id').eq('id', ctx.params.id).eq('cart_id', cartId).maybeSingle();
  if (!line) throw new HttpError(404, 'not_found', 'That item is not in your bag.');
  if (quantity === 0) must(await db().from('cart_items').delete().eq('id', line.id), 'remove cart item');
  else must(await db().from('cart_items').update({ quantity }).eq('id', line.id), 'update cart item');
  return (await priceCart(cartId)).cart;
});
route('DELETE', '/cart/items/:id', async ctx => {
  const cartId = await cartFor(ctx);
  if (isUuid(ctx.params.id)) must(await db().from('cart_items').delete().eq('id', ctx.params.id).eq('cart_id', cartId), 'remove cart item');
  return (await priceCart(cartId)).cart;
});
route('PUT', '/cart/coupon', async ctx => {
  const cartId = await cartFor(ctx);
  await applyCoupon(cartId, (await ctx.body(applyCouponSchema)).code);
  return (await priceCart(cartId)).cart;
});
route('DELETE', '/cart/coupon', async ctx => {
  const cartId = await cartFor(ctx);
  must(await db().from('carts').update({ coupon_code: null }).eq('id', cartId), 'remove coupon');
  return (await priceCart(cartId)).cart;
});

// ───────────── orders & payments ─────────────

const placeErrors: Record<string, [number, string, string]> = {
  out_of_stock: [409, 'out_of_stock', 'An item in your bag just sold out. Review your bag and try again.'],
  cart_empty: [409, 'cart_empty', 'Your bag is empty.'],
  price_changed: [409, 'quantity_changed', 'Prices or stock changed while you were checking out. Review your bag and try again.'],
};

route('POST', '/orders', async ctx => {
  // Sign-in is mandatory (no guest checkout). Checked before anything else: no cart, stock, order or payment work happens for a guest.
  const customer = await requireCustomer(ctx);
  const key = ctx.req.headers.get('idempotency-key');
  if (!key || key.length < 8 || key.length > 128) throw new HttpError(400, 'idempotency_key_required', 'An Idempotency-Key header is required.');
  const input = await ctx.body(createOrderRequestSchema);
  const cartId = isUuid(ctx.cookies[COOKIES.cart]) ? ctx.cookies[COOKIES.cart] : null;
  const fingerprint = sha256(JSON.stringify({ input, cartId }));
  const { data: prior } = await db().from('idempotency_keys').select('fingerprint, response').eq('key', key).maybeSingle();
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new HttpError(422, 'idempotency_key_reuse', 'That Idempotency-Key was already used for a different request.');
    return json(prior.response, 200);
  }
  if (!cartId) throw new HttpError(409, 'cart_empty', 'Your bag is empty.');
  await rateLimit(`order:${ctx.ip}`, 20, 3600);

  const online = input.paymentMethod !== 'cod';
  if (online && !getServerEnv().razorpay) throw new HttpError(409, 'payment_unavailable', 'Online payment is not available right now. Please choose Cash on delivery.');
  const rule = await pincodeRule(input.shippingAddress.pincode);
  if (!rule || !rule.serviceable) throw new HttpError(422, 'not_serviceable', rule?.message ?? 'We do not deliver to this pincode yet.', { 'shippingAddress.pincode': ['Not serviceable'] });
  if (input.paymentMethod === 'cod' && !rule.cod_available) throw new HttpError(422, 'cod_unavailable', 'Cash on delivery is not available for this pincode.');

  const priced = await priceCart(cartId);
  if (!priced.cart.lines.length) throw new HttpError(409, 'cart_empty', 'Your bag is empty.');
  const soldOut = priced.cart.lines.find(line => line.issue === 'out_of_stock');
  if (soldOut) throw new HttpError(409, 'out_of_stock', `${soldOut.name} (${soldOut.size}) is out of stock. Remove it to continue.`);
  if (priced.blocked) throw new HttpError(409, 'quantity_changed', 'Stock changed while you were checking out. Review your bag and try again.');

  const lookupToken = newToken(24);
  const { data: orderId, error } = await db().rpc('place_order', { p: {
    cart_id: cartId, customer_id: customer.id, contact: input.contact, shipping_address: input.shippingAddress, payment_method: input.paymentMethod,
    coupon_code: priced.coupon ?? '', discount: priced.cart.totals.discount, shipping: priced.cart.totals.shipping, expected_subtotal: priced.cart.totals.subtotal,
    lookup_token_hash: sha256(lookupToken), provider: online ? 'razorpay' : 'cod',
  } });
  if (error) {
    const mapped = placeErrors[(error.message ?? '').trim()];
    if (mapped) throw new HttpError(...mapped);
    console.error('[backend] place_order', error.message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }

  const payment = must(await db().from('payments').select('id, provider, status').eq('order_id', orderId).single(), 'payment') as Row;
  let action: unknown = null;
  if (online) {
    try {
      const total = priced.cart.totals.total;
      const provider = await createRazorpayOrder(total, String(orderId));
      must(await db().from('payments').update({ provider_order_id: provider.id }).eq('id', payment.id), 'payment update');
      const razorpay = getServerEnv().razorpay!;
      action = { type: 'sdk', provider: 'razorpay', payload: { keyId: razorpay.keyId, orderId: provider.id, amount: Math.round(total * 100), currency: 'INR', prefill: { name: input.contact.name, email: input.contact.email, contact: input.contact.phone } } };
    } catch (cause) {
      await db().rpc('transition_order', { p_order: orderId, p_to: 'cancelled', p_actor: null, p_note: 'Payment could not be started' });
      throw cause;
    }
  }
  const order = toOrder((await loadOrder(orderId as string))!);
  const response = { order, payment: { id: payment.id, provider: payment.provider, status: order.paymentStatus, action }, lookupToken };
  await db().from('idempotency_keys').insert({ key, fingerprint, response });
  if (!online) await sendOrderEmail(orderMailData(order), 'confirmation');
  return json(response, 201);
});

async function orderAccess(ctx: Parameters<typeof currentCustomer>[0], row: Row) {
  const token = ctx.url.searchParams.get('token');
  if (token) {
    await rateLimit(`track:${ctx.ip}`, 60, 600, 'Too many lookups. Please wait a few minutes.');
    if (safeEqual(sha256(token), row.lookup_token_hash) || safeEqual(token, trackingToken(row.id))) return;
  }
  const customer = await currentCustomer(ctx);
  if (customer && row.customer_id === customer.id) return;
  throw new HttpError(404, 'not_found', 'Order not found.');
}
route('GET', '/orders/:id', async ctx => {
  const row = isUuid(ctx.params.id) ? await loadOrder(ctx.params.id) : null;
  if (!row) throw new HttpError(404, 'not_found', 'Order not found.');
  await orderAccess(ctx, row);
  return (await presentOrders([row]))[0];
});

const migrationRequired = (message: string | undefined) => /does not exist|schema cache|PGRST202|42883|42P01/.test(message ?? '');
const loadAccessible = async (ctx: Parameters<typeof orderAccess>[0]) => {
  const row = isUuid(ctx.params.id) ? await loadOrder(ctx.params.id) : null;
  if (!row) throw new HttpError(404, 'not_found', 'Order not found.');
  await orderAccess(ctx, row);
  return row;
};

route('POST', '/orders/:id/cancel', async ctx => {
  const row = await loadAccessible(ctx);
  const { reason } = await ctx.body(cancelOrderRequestSchema);
  if (!isCancellable(row.status) && row.status !== 'cancelled') throw new HttpError(409, 'not_cancellable', row.status === 'delivered' ? 'This order was delivered, so it can no longer be cancelled. You can request a return instead.' : 'This order has already shipped, so it can no longer be cancelled.');
  const { data, error } = await db().rpc('cancel_order_customer', { p_order: row.id, p_reason: reason });
  if (error) {
    if ((error.message ?? '').includes('not_cancellable')) throw new HttpError(409, 'not_cancellable', 'This order can no longer be cancelled.');
    if (migrationRequired(error.message)) throw new HttpError(503, 'migration_required', 'Cancellation needs database migration 0005. Ask the developer to apply it.');
    console.error('[backend] cancel_order_customer', error.message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  const [order] = await presentOrders([(await loadOrder(row.id))!]);
  if ((data as Row).changed) await sendOrderEmail(orderMailData(order), 'status');
  return order;
});

route('POST', '/orders/:id/returns', async ctx => {
  const row = await loadAccessible(ctx);
  const input = await ctx.body(createReturnRequestSchema);
  const customer = await currentCustomer(ctx);
  const { data: returnId, error } = await db().rpc('create_return', { p_order: row.id, p_customer: customer && row.customer_id === customer.id ? customer.id : null, p_items: input.items.map(i => ({ order_item_id: i.orderItemId, quantity: i.quantity })), p_reason: input.reason });
  if (error) {
    const message = error.message ?? '';
    const known: Record<string, [number, string, string]> = {
      not_delivered: [409, 'return_not_allowed', 'Returns can only be requested after the order has been delivered.'],
      window_closed: [409, 'return_window_closed', 'The return window for this order has closed.'],
      not_returnable: [409, 'not_returnable', `${error.details ?? 'This item'} cannot be returned.`],
      quantity_exceeded: [409, 'quantity_exceeded', `You can only return the quantity you bought (${error.details ?? 'item'}), minus anything already requested.`],
      bad_item: [422, 'validation_failed', 'That item is not part of this order.'],
      no_items: [422, 'validation_failed', 'Choose at least one item to return.'],
    };
    const hit = Object.keys(known).find(code => message.includes(code));
    if (hit) throw new HttpError(...known[hit]);
    if (migrationRequired(message)) throw new HttpError(503, 'migration_required', 'Returns need database migration 0005. Ask the developer to apply it.');
    console.error('[backend] create_return', message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  const [order] = await presentOrders([(await loadOrder(row.id))!]);
  const created = order.returns!.find(r => r.id === returnId)!;
  await sendReturnEmail({ id: created.id, number: created.number, orderNumber: order.number, status: 'requested', to: order.contact.email, name: order.contact.name, trackUrl: trackingUrl(order.id) });
  return json(created, 201);
});

route('POST', '/payments/:id/verify', async ctx => {
  // Browser-side confirmation after checkout: the signed-in customer who owns the order. (Razorpay's own server-to-server webhook is a separate, signature-verified route.)
  const customer = await requireCustomer(ctx);
  const { payload } = await ctx.body(verifyPaymentRequestSchema);
  const { data: payment } = isUuid(ctx.params.id) ? await db().from('payments').select('id, provider, provider_order_id, order_id').eq('id', ctx.params.id).maybeSingle() : { data: null };
  if (!payment) throw new HttpError(404, 'not_found', 'Payment not found.');
  const { data: owner } = await db().from('orders').select('customer_id').eq('id', payment.order_id).maybeSingle();
  if (!owner || owner.customer_id !== customer.id) throw new HttpError(404, 'not_found', 'Payment not found.');
  const { razorpay_order_id: rzpOrder, razorpay_payment_id: rzpPayment, razorpay_signature: signature } = payload as Record<string, string>;
  if (payment.provider !== 'razorpay' || typeof rzpOrder !== 'string' || typeof rzpPayment !== 'string' || typeof signature !== 'string'
    || rzpOrder !== payment.provider_order_id || !verifyRazorpayPayment(rzpOrder, rzpPayment, signature)) {
    throw new HttpError(422, 'payment_verification_failed', 'We could not verify this payment. If money was deducted, it will be reconciled automatically.');
  }
  const { data: settled, error } = await db().rpc('settle_payment', { p_order: payment.order_id, p_provider_payment: rzpPayment, p_success: true });
  if (error) { console.error('[backend] settle_payment', error.message); throw new HttpError(500, 'server_error', 'Something went wrong.'); }
  if ((settled as Row).changed) {
    const row = await loadOrder(payment.order_id);
    if (row) await sendOrderEmail(orderMailData(toOrder(row)), 'confirmation');
  }
  return { id: payment.id, provider: payment.provider, status: (settled as Row).payment_status, action: null };
});

route('GET', '/me/orders', async ctx => {
  const customer = await requireCustomer(ctx);
  const { page, pageSize } = pageParams(ctx.url, 20);
  const { data, error, count } = await db().from('orders').select(ORDER_SELECT, { count: 'exact' }).eq('customer_id', customer.id).order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  return { items: await presentOrders((data ?? []) as Row[]), total: count ?? 0, page, pageSize };
});

// ───────────── customer account ─────────────

/**
 * Gatekeeper for the MSG91 OTP Widget. The browser sends/retries/verifies the code with MSG91 directly, so this endpoint (called before every send and
 * every resend) is where OUR limits still apply: 3 per phone / 10 min, 15 per IP / hour, 5-min request lifetime. It returns a single-use requestId that
 * binds the later token to this phone number, plus the public widget id / tokenAuth. A client that skips this endpoint and talks to MSG91 directly can only
 * cost SMS (limited by MSG91 itself); it still cannot sign in, because /verify requires a live requestId and a token MSG91 confirms server-side.
 */
// Public widget identifiers (not secrets), needed by the browser to draw the CAPTCHA before the first send. The Authkey is never included.
route('GET', '/auth/otp/config', async () => {
  const msg91 = getServerEnv().msg91;
  if (!msg91) throw new HttpError(503, 'sms_not_configured', 'Sign-in by SMS is not available yet.');
  return { widgetId: msg91.widgetId, tokenAuth: msg91.tokenAuth };
});

route('POST', '/auth/otp/request', async ctx => {
  const { phone } = await ctx.body(otpRequestSchema);
  const msg91 = getServerEnv().msg91;
  if (!msg91) throw new HttpError(503, 'sms_not_configured', 'Sign-in by SMS is not available yet.');
  await rateLimit(`otp:${phone}`, 3, 600, 'Too many codes requested. Please wait a few minutes.').catch(error => noteRateLimit(error, 'rate_limited_phone'));
  await rateLimit(`otp-ip:${ctx.ip}`, 15, 3600).catch(error => noteRateLimit(error, 'rate_limited_ip'));
  const inserted = must(await db().from('otp_requests').insert({ phone, code_hash: 'msg91-widget', expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }).select('id').single(), 'otp') as Row;
  return json({ requestId: inserted.id, expiresInSeconds: 300, resendAfterSeconds: 30, widgetId: msg91.widgetId, tokenAuth: msg91.tokenAuth });
});

route('POST', '/auth/otp/verify', async ctx => {
  const input = await ctx.body(otpVerifySchema).catch(noteValidationFailure);
  const { data: request } = isUuid(input.requestId) ? await db().from('otp_requests').select('*').eq('id', input.requestId).maybeSingle() : { data: null };
  checkOtpRequest(request, input.phone);
  must(await db().from('otp_requests').update({ attempts: request.attempts + 1 }).eq('id', request.id), 'otp attempts');
  const verifiedPhone = await verifyOtpAccessToken(input.accessToken);
  requireSameMobile(verifiedPhone, input.phone, safeEqual);
  // A verified token signs in once: the request row is consumed and the token hash is burned.
  await rateLimit(`otp-token:${sha256(input.accessToken)}`, 1, 86_400, 'That code has already been used. Request a new one.').catch(error => noteRateLimit(error, 'token_reused'));
  await db().from('otp_requests').delete().eq('id', request.id);
  let { data: customer } = await db().from('customers').select('id, phone, name, email').eq('phone', input.phone).maybeSingle();
  const existing = Boolean(customer);
  if (!customer) customer = must(await db().from('customers').insert({ phone: input.phone }).select('id, phone, name, email').single(), 'customer') as Row as any;
  const token = newToken();
  must(await db().from('customer_sessions').insert({ token_hash: sha256(token), customer_id: customer!.id, expires_at: new Date(Date.now() + CUSTOMER_SESSION_SECONDS * 1000).toISOString() }), 'session');
  ctx.setCookie(COOKIES.customer, token, CUSTOMER_SESSION_SECONDS);
  logOtp('verified', { newCustomer: !existing });
  return { customer };
});
route('POST', '/auth/logout', async ctx => {
  if (ctx.cookies[COOKIES.customer]) await db().from('customer_sessions').delete().eq('token_hash', sha256(ctx.cookies[COOKIES.customer]));
  ctx.setCookie(COOKIES.customer, '', 0);
  return null;
});
route('GET', '/me', async ctx => requireCustomer(ctx));

route('GET', '/me/wishlist', async ctx => {
  const customer = await requireCustomer(ctx);
  const rows = must(await db().from('wishlist_items').select('product_id').eq('customer_id', customer.id).order('created_at', { ascending: false }), 'wishlist') as Row[];
  return { productIds: rows.map(r => r.product_id) };
});
route('PUT', '/me/wishlist/:productId', async ctx => {
  const customer = await requireCustomer(ctx);
  if (!isUuid(ctx.params.productId)) throw new HttpError(404, 'not_found', 'Product not found.');
  const { error } = await db().from('wishlist_items').upsert({ customer_id: customer.id, product_id: ctx.params.productId }, { onConflict: 'customer_id,product_id', ignoreDuplicates: true });
  if (error?.code === '23503') throw new HttpError(404, 'not_found', 'Product not found.');
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  return null;
});
route('DELETE', '/me/wishlist/:productId', async ctx => {
  const customer = await requireCustomer(ctx);
  if (isUuid(ctx.params.productId)) must(await db().from('wishlist_items').delete().eq('customer_id', customer.id).eq('product_id', ctx.params.productId), 'wishlist');
  return null;
});

const addressDto = (r: Row) => ({ id: r.id, label: r.label, name: r.name, phone: r.phone, line1: r.line1, line2: r.line2, city: r.city, state: r.state, pincode: r.pincode, isDefault: r.is_default });
route('GET', '/me/addresses', async ctx => {
  const customer = await requireCustomer(ctx);
  return { items: (must(await db().from('customer_addresses').select('*').eq('customer_id', customer.id).order('created_at'), 'addresses') as Row[]).map(addressDto) };
});
route('POST', '/me/addresses', async ctx => {
  const customer = await requireCustomer(ctx);
  const input = await ctx.body(savedAddressInputSchema);
  const { count } = await db().from('customer_addresses').select('id', { count: 'exact', head: true }).eq('customer_id', customer.id);
  if ((count ?? 0) >= 10) throw new HttpError(409, 'address_limit', 'You can save up to 10 addresses.');
  if (input.isDefault) await db().from('customer_addresses').update({ is_default: false }).eq('customer_id', customer.id);
  const row = must(await db().from('customer_addresses').insert({ customer_id: customer.id, label: input.label, name: input.name, phone: input.phone, line1: input.line1, line2: input.line2 ?? null, city: input.city, state: input.state, pincode: input.pincode, is_default: input.isDefault }).select('*').single(), 'address') as Row;
  return json(addressDto(row), 201);
});
route('DELETE', '/me/addresses/:id', async ctx => {
  const customer = await requireCustomer(ctx);
  if (isUuid(ctx.params.id)) must(await db().from('customer_addresses').delete().eq('id', ctx.params.id).eq('customer_id', customer.id), 'address');
  return null;
});

// ───────────── newsletter & leads ─────────────

route('POST', '/newsletter/subscriptions', async ctx => {
  const { email } = await ctx.body(newsletterRequestSchema);
  await rateLimit(`newsletter:${ctx.ip}`, 10, 3600);
  must(await db().from('newsletter_subscriptions').upsert({ email, status: 'subscribed' }, { onConflict: 'email', ignoreDuplicates: true }), 'newsletter');
  return json({ status: 'subscribed' }, 202);
});

route('POST', '/leads', async ctx => {
  const input = await ctx.body(leadRequestSchema);
  await rateLimit(`lead:${ctx.ip}`, 10, 3600);
  const dedupeKey = sha256(`${input.email}|${input.type}|${input.message.trim().toLowerCase()}|${new Date().toISOString().slice(0, 10)}`);
  const inserted = await db().from('leads').insert({ ...input, source: 'website', dedupe_key: dedupeKey }).select('id').single();
  if (isUnique(inserted.error)) {
    const { data: existing } = await db().from('leads').select('id').eq('dedupe_key', dedupeKey).single();
    return json({ id: existing!.id }, 200);
  }
  const lead = must(inserted, 'lead') as Row;
  await db().from('lead_activity').insert({ lead_id: lead.id, kind: 'created', note: 'Submitted from the website' });
  // The lead is already saved; a failed notification must never fail the request.
  await sendLeadEmails({ id: lead.id, ...input });
  return json({ id: lead.id }, 201);
});
