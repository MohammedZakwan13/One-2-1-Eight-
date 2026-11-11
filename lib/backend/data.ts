/* eslint-disable @typescript-eslint/no-explicit-any -- database rows are validated by the API schemas at the HTTP boundary */
import 'server-only';
import { luxeFeatureSchema, type AdminProduct, type Cart, type LuxeFeature, type Order, type Product, type StoreSettings } from '@/lib/api/schemas';
import { getServerEnv } from '@/lib/env';
import { HttpError, db, imageUrl, must, trackingUrl } from '@/lib/backend/core';

export type Row = Record<string, any>;

// ───────────── settings ─────────────

export async function getSettingsRow(): Promise<Row> {
  const { data, error } = await db().from('store_settings').select('*').eq('id', 1).maybeSingle();
  if (error) { console.error('[backend] settings', error.message); throw new HttpError(500, 'server_error', 'Something went wrong.'); }
  if (!data) throw new HttpError(503, 'not_initialised', 'Store settings are missing. Run supabase/seed.sql.');
  return data;
}

export const toSettings = (r: Row): StoreSettings => ({
  brandName: r.brand_name, brandLine: r.brand_line, promoText: r.promo_text, announcementEnabled: r.announcement_enabled,
  freeShippingThreshold: Number(r.free_shipping_threshold), shippingFee: Number(r.shipping_fee), lowStockThreshold: r.low_stock_threshold,
  returnPolicy: r.return_policy, seoTitle: r.seo_title, seoDescription: r.seo_description, contactEmail: r.contact_email, contactPhone: r.contact_phone,
  instagramUrl: r.instagram_url, whatsappNumber: r.whatsapp_number, productOfferCode: r.product_offer_code, productOfferText: r.product_offer_text,
});

/** Saved Luxe band content as the API shows it. Anything missing or invalid is treated as "not configured" (the storefront then uses its built-in copy). */
export const toLuxeFeature = (r: Row): LuxeFeature | null => {
  const v = r.luxe_feature;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const text = (key: string) => (typeof v[key] === 'string' ? v[key] : '');
  const parsed = luxeFeatureSchema.safeParse({
    enabled: v.enabled !== false, image: text('image') ? imageUrl(text('image')) : '', imageAlt: text('imageAlt'), eyebrow: text('eyebrow'), heading: text('heading'),
    bodyLine1: text('bodyLine1'), bodyLine2: text('bodyLine2'), ctaLabel: text('ctaLabel'), ctaHref: text('ctaHref'),
  });
  if (!parsed.success) { console.error('[backend] luxe_feature is invalid; the storefront uses its default copy'); return null; }
  return parsed.data;
};

export const paymentMethods = (): Array<'upi' | 'card' | 'cod'> => (getServerEnv().razorpay ? ['upi', 'card', 'cod'] : ['cod']);

// ───────────── catalogue ─────────────

export const PRODUCT_SELECT = '*, categories(id, name, slug), product_variants(id, sku, size, stock, active, sort_order)';

export function availability(stock: number, threshold: number) {
  // Public callers only ever see the status — real quantities never leave the server (admin responses carry `stock` separately).
  return { status: (stock <= 0 ? 'out_of_stock' : stock <= threshold ? 'low_stock' : 'in_stock') as 'in_stock' | 'low_stock' | 'out_of_stock' };
}

/** Public availability. The exact quantity is exposed only for products whose stock message mode is 'real'. */
export function publicAvailability(mode: string, stock: number, threshold: number) {
  return mode === 'real' ? { ...availability(stock, threshold), quantity: Math.max(0, stock) } : availability(stock, threshold);
}

/** Legacy rows (no mode column yet, or mode left at the default) keep any saved text as a Custom Stock Note. */
/** Exact stock is public only for Real Stock products. Every other product gets the product-wide cap and a generic message. */
export const lineMaxQuantity = (mode: string, stock: number) => (mode === 'real' ? Math.min(stock, MAX_LINE_QUANTITY) : MAX_LINE_QUANTITY);
export const limitedAvailabilityMessage = (mode: string, stock: number, name: string, size: string) =>
  mode === 'real' ? `Only ${stock} of ${name} (${size}) are available.` : `${name} (${size}) has limited availability, so the quantity in your bag was adjusted.`;

export const rowStockMode = (r: Row): 'none' | 'real' | 'custom' => (r.stock_message_mode && r.stock_message_mode !== 'none' ? r.stock_message_mode : r.stock_message_mode === undefined && r.stock_message?.trim() ? 'custom' : 'none');

const activeVariants = (row: Row): Row[] => (row.product_variants ?? []).filter((v: Row) => v.active).sort((a: Row, b: Row) => a.sort_order - b.sort_order);

export async function reviewStats(productIds: string[]) {
  const stats = new Map<string, { sum: number; count: number; distribution: Record<'1' | '2' | '3' | '4' | '5', number> }>();
  if (!productIds.length) return stats;
  const rows = must(await db().from('reviews').select('product_id, rating').eq('status', 'published').in('product_id', productIds), 'review stats') as Row[];
  for (const r of rows) {
    const entry = stats.get(r.product_id) ?? { sum: 0, count: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } };
    entry.sum += r.rating; entry.count += 1; entry.distribution[String(r.rating) as '1'] += 1;
    stats.set(r.product_id, entry);
  }
  return stats;
}

export async function toProducts(rows: Row[], settings: Row): Promise<Product[]> {
  const stats = await reviewStats(rows.map(r => r.id));
  const threshold = settings.low_stock_threshold as number;
  return rows.map(r => {
    const stat = stats.get(r.id);
    const mode = rowStockMode(r);
    return {
      id: r.id, slug: r.slug, name: r.name, category: r.categories.name, categorySlug: r.categories.slug, price: Number(r.price), compareAt: Number(r.compare_at),
      color: r.color, colorHex: r.color_hex, rating: stat ? Math.round((stat.sum / stat.count) * 10) / 10 : 0, reviewCount: stat?.count ?? 0, badge: r.badge,
      images: (r.images as string[]).map(imageUrl), fit: r.fit, material: r.material, description: r.description, bestSeller: r.best_seller, newArrival: r.new_arrival, luxe: r.luxe,
      stockMessage: mode === 'none' ? null : (r.stock_message ?? null),
      stockMessageMode: mode,
      stockMessageNumber: mode === 'custom' ? (r.stock_message_number ?? null) : null,
      returnable: r.returnable === false ? false : (r.returnable ?? true),
      exchangeable: r.exchangeable === false ? false : (r.exchangeable ?? (r.returnable === false ? false : true)),
      codEnabled: r.cod_enabled === false ? false : (r.cod_enabled ?? true),
      onlinePaymentEnabled: r.online_payment_enabled === false ? false : (r.online_payment_enabled ?? true),
      variants: activeVariants(r).map(v => ({ id: v.id, sku: v.sku, size: v.size, availability: publicAvailability(mode, v.stock, threshold) })),
      updatedAt: r.updated_at,
    };
  });
}

export function toAdminProduct(r: Row, settings: Row, publicProduct: Product): AdminProduct {
  const threshold = settings.low_stock_threshold as number;
  const live = activeVariants(r);
  return {
    ...publicProduct, categoryId: r.category_id, status: r.status,
    stockMessage: r.stock_message ?? null,
    stockMessageNumber: r.stock_message_number ?? null,
    stockMessageReview: r.stock_message_review === true,
    variants: live.map(v => ({ id: v.id, sku: v.sku, size: v.size, stock: v.stock, availability: availability(v.stock, threshold) })),
  };
}

/**
 * "You may also like": real, active, in-stock products only; never the current one; same category first, then best sellers / newest.
 * Pure so it can be unit-tested. Rows come from PRODUCT_SELECT.
 */
export function selectRelated(current: Row, candidates: Row[], limit: number): Row[] {
  const sellable = (r: Row) => r.status === 'active' && r.id !== current.id && activeVariants(r).some(v => v.stock > 0);
  const seen = new Set<string>();
  const rank = (r: Row) => (r.category_id === current.category_id ? 0 : 1);
  return candidates.filter(sellable)
    .sort((a, b) => rank(a) - rank(b) || Number(b.best_seller) - Number(a.best_seller) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    .filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .slice(0, limit);
}

// ───────────── cart pricing ─────────────

export const MAX_LINE_QUANTITY = 20;
const CART_SELECT = 'id, quantity, variant_id, product_variants(id, sku, size, stock, active, products(*))';

async function evaluateCoupon(code: string, subtotal: number, hasLuxe: boolean): Promise<{ discount: number; description: string; reason?: string } | null> {
  const { data: coupon } = await db().from('coupons').select('*').eq('code', code).maybeSingle();
  const now = Date.now();
  if (!coupon || !coupon.active || (coupon.starts_at && Date.parse(coupon.starts_at) > now) || (coupon.ends_at && Date.parse(coupon.ends_at) < now)
    || (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit)) return null;
  const description = coupon.description || code;
  if (subtotal < Number(coupon.min_subtotal)) return { discount: 0, description, reason: `Add ₹${Math.ceil(Number(coupon.min_subtotal) - subtotal)} more to use this code.` };
  if (coupon.requires_luxe && !hasLuxe) return { discount: 0, description, reason: 'This code needs a Luxe piece in your bag.' };
  const raw = coupon.kind === 'percent' ? (subtotal * Number(coupon.value)) / 100 : Number(coupon.value);
  return { discount: Math.min(subtotal, Math.round(raw)), description };
}

export type PricedCart = { cart: Cart; blocked: boolean; coupon: string | null };

/** Prices the cart from live database rows, repairing it (removing dead lines, clamping quantities) as it goes. */
export async function priceCart(cartId: string): Promise<PricedCart> {
  const settings = await getSettingsRow();
  const cartRow = must(await db().from('carts').select('id, coupon_code').eq('id', cartId).single(), 'cart') as Row;
  const items = must(await db().from('cart_items').select(CART_SELECT).eq('cart_id', cartId).order('created_at').order('id'), 'cart items') as Row[];
  const messages: string[] = [];
  const lines: Cart['lines'] = [];
  let blocked = false;
  for (const item of items) {
    const variant = item.product_variants as Row | null;
    const product = variant?.products as Row | undefined;
    if (!variant || !variant.active || !product || product.status !== 'active') {
      await db().from('cart_items').delete().eq('id', item.id);
      messages.push('An item in your bag is no longer available and was removed.');
      continue;
    }
    let quantity = item.quantity as number;
    let issue: 'out_of_stock' | 'quantity_reduced' | null = null;
    if (variant.stock <= 0) { issue = 'out_of_stock'; blocked = true; }
    else if (quantity > variant.stock) {
      quantity = variant.stock; issue = 'quantity_reduced';
      // Exact quantities are public only for products in Real Stock mode; everyone else gets a generic message.
      messages.push(limitedAvailabilityMessage(rowStockMode(product), variant.stock, product.name, variant.size));
      await db().from('cart_items').update({ quantity }).eq('id', item.id);
    }
    const price = Number(product.price);
    const returnable = product.returnable === false ? false : (product.returnable ?? true);
    const exchangeable = product.exchangeable === false ? false : (product.exchangeable ?? (product.returnable === false ? false : true));
    const codEnabled = product.cod_enabled === false ? false : (product.cod_enabled ?? true);
    const onlinePaymentEnabled = product.online_payment_enabled === false ? false : (product.online_payment_enabled ?? true);
    if (!codEnabled && !onlinePaymentEnabled) {
      issue = 'out_of_stock';
      blocked = true;
      messages.push(`${product.name} is currently not available for purchase.`);
    }
    lines.push({
      id: item.id, variantId: variant.id, productId: product.id, slug: product.slug, name: product.name, image: imageUrl((product.images as string[])[0] ?? ''), color: product.color,
      size: variant.size, quantity, unitPrice: price, compareAt: Number(product.compare_at), lineTotal: price * quantity, maxQuantity: lineMaxQuantity(rowStockMode(product), variant.stock), issue,
      returnable, exchangeable, codEnabled, onlinePaymentEnabled,
    });
  }
  const payable = lines.filter(line => line.issue !== 'out_of_stock');
  const subtotal = payable.reduce((sum, line) => sum + line.lineTotal, 0);
  const hasLuxe = items.some(item => item.product_variants?.products?.luxe);

  const availableStoreMethods = paymentMethods();
  const onlineGatewayConfigured = availableStoreMethods.includes('upi') || availableStoreMethods.includes('card');
  const codAllowed = payable.length > 0 && payable.every(line => line.codEnabled !== false);
  const onlineAllowed = payable.length > 0 && payable.every(line => line.onlinePaymentEnabled !== false);
  const allowedPaymentMethods: Array<'upi' | 'card' | 'cod'> = [];
  if (codAllowed && availableStoreMethods.includes('cod')) {
    allowedPaymentMethods.push('cod');
  }
  if (onlineAllowed) {
    if (availableStoreMethods.includes('upi')) allowedPaymentMethods.push('upi');
    if (availableStoreMethods.includes('card')) allowedPaymentMethods.push('card');
  }
  const paymentConflict = payable.length > 0 && !codAllowed && !onlineAllowed;
  const onlineConfiguring = payable.length > 0 && onlineAllowed && !codAllowed && !onlineGatewayConfigured;

  if (paymentConflict) {
    blocked = true;
    messages.push('Items in your bag have conflicting payment options (some allow only Cash on Delivery, while others allow only Online Payment). Please purchase them separately.');
  } else if (onlineConfiguring) {
    blocked = true;
    messages.push('Online payment is currently being configured. Cash on delivery is unavailable for one or more items in your bag.');
  }

  let discount = 0;
  let coupon: Cart['coupon'] = null;
  if (cartRow.coupon_code) {
    const result = await evaluateCoupon(cartRow.coupon_code, subtotal, hasLuxe);
    if (result && result.discount > 0) { discount = result.discount; coupon = { code: cartRow.coupon_code, description: result.description }; }
    else {
      await db().from('carts').update({ coupon_code: null }).eq('id', cartId);
      messages.push(`Coupon removed: ${result?.reason ?? 'it is no longer valid.'}`);
    }
  }
  const threshold = Number(settings.free_shipping_threshold);
  const shipping = subtotal === 0 || subtotal - discount >= threshold ? 0 : Number(settings.shipping_fee);
  return {
    cart: { id: cartId, currency: 'INR', lines, coupon, totals: { subtotal, discount, shipping, total: Math.max(0, subtotal - discount + shipping) }, freeShippingThreshold: threshold, messages, allowedPaymentMethods, paymentConflict, codAllowed, onlineAllowed, onlineGatewayConfigured },
    blocked: blocked || messages.some(m => m.startsWith('Only')),
    coupon: coupon?.code ?? null,
  };
}

export async function applyCoupon(cartId: string, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  const current = await priceCart(cartId);
  const luxeRows = current.cart.lines.length ? must(await db().from('products').select('luxe').in('id', current.cart.lines.map(l => l.productId)), 'luxe') as Row[] : [];
  const result = await evaluateCoupon(code, current.cart.totals.subtotal, luxeRows.some(r => r.luxe));
  if (!result) throw new HttpError(422, 'coupon_invalid', 'That code is not available for this bag.');
  if (result.discount <= 0) throw new HttpError(422, 'coupon_not_applicable', result.reason ?? 'That code is not available for this bag.');
  must(await db().from('carts').update({ coupon_code: code, updated_at: new Date().toISOString() }).eq('id', cartId), 'apply coupon');
}

// ───────────── orders ─────────────

export const ORDER_SELECT = '*, order_items(*), order_status_history(to_status, created_at, note, actor_type)';

export function toOrder(r: Row): Order {
  const history = [...(r.order_status_history ?? [])].sort((a: Row, b: Row) => a.created_at.localeCompare(b.created_at));
  return {
    id: r.id, number: r.number, status: r.status, paymentStatus: r.payment_status, paymentMethod: r.payment_method, currency: 'INR',
    totals: { subtotal: Number(r.subtotal), discount: Number(r.discount), shipping: Number(r.shipping), total: Number(r.total) },
    lines: (r.order_items ?? []).map((i: Row) => ({
      id: i.id, returnable: i.returnable === false ? false : (i.returnable ?? true), exchangeable: i.exchangeable === false ? false : (i.exchangeable ?? (i.returnable === false ? false : true)), productId: i.product_id, variantId: i.variant_id, name: i.name, image: imageUrl(i.image), size: i.size, color: i.color, quantity: i.quantity, unitPrice: Number(i.unit_price), lineTotal: Number(i.line_total),
    })),
    contact: r.contact, shippingAddress: r.shipping_address, createdAt: r.created_at,
    history: history.map((h: Row) => ({ status: h.to_status, at: h.created_at, note: h.actor_type === 'admin' ? null : h.note })),
    shipment: r.carrier || r.tracking_number || r.tracking_url ? { carrier: r.carrier, trackingNumber: r.tracking_number, trackingUrl: r.tracking_url } : null,
  };
}

export async function loadOrder(id: string): Promise<Row | null> {
  const { data, error } = await db().from('orders').select(ORDER_SELECT).eq('id', id).maybeSingle();
  if (error) { console.error('[backend] order', error.message); throw new HttpError(500, 'server_error', 'Something went wrong.'); }
  return data;
}

export const orderMailData = (order: Order) => ({
  trackUrl: trackingUrl(order.id), id: order.id, number: order.number, status: order.status, total: order.totals.total, contact: order.contact, paymentMethod: order.paymentMethod,
  lines: order.lines.map(line => ({ name: line.name, size: line.size, quantity: line.quantity })), shipment: order.shipment,
});
