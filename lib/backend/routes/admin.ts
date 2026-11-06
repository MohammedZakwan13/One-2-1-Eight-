import { MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_LABEL } from '@/lib/upload-limits';
import { summarizeLowStock } from '@/lib/inventory';
import { productPayload, saveProductError } from '@/lib/backend/product-payload';
import 'server-only';
import { slugify } from '@/lib/format';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  adminCategoryCreateSchema, adminCategoryUpdateSchema, adminHeroSlideUpdateSchema, adminLoginRequestSchema, adminPageInputSchema, adminProductInputSchema, bulkFlagRequestSchema,
  storeSettingsSchema, updateLeadStatusSchema, updateOrderStatusSchema, updateReturnSchema, updateReviewStatusSchema,
} from '@/lib/api/schemas';
import { ADMIN_SESSION_SECONDS, requireAdmin } from '@/lib/backend/auth';
import {
  HttpError, MEDIA_BUCKET, authClient, csv, db, imageUrl, isStoragePath, isUnique, isUuid, json, must, newToken, pageParams, rateLimit, removeStorageObjects, route, sha256,
  storedImage,
} from '@/lib/backend/core';
import { ORDER_SELECT, PRODUCT_SELECT, getSettingsRow, loadOrder, orderMailData, toAdminProduct, toOrder, toProducts, toSettings, type Row } from '@/lib/backend/data';
import { sendOrderEmail, sendReturnEmail } from '@/lib/backend/integrations';
import { presentOrders, toReturnDto, trackingUrl } from '@/lib/backend/returns';
import { heroDto } from '@/lib/backend/routes/storefront';
import { getServerEnv } from '@/lib/env';

const categoryDto = (r: Row) => ({ id: r.id, name: r.name, slug: r.slug, image: imageUrl(r.image), active: r.active });

// ───────────── auth ─────────────

route('POST', '/admin/auth/login', async ctx => {
  const { email, password } = await ctx.body(adminLoginRequestSchema);
  const key = email.toLowerCase();
  await rateLimit(`admin-login:${key}`, 5, 900, 'Too many failed attempts. Try again in a few minutes.');
  await rateLimit(`admin-login-ip:${ctx.ip}`, 30, 900, 'Too many failed attempts. Try again in a few minutes.');
  const invalid = new HttpError(401, 'invalid_credentials', 'That email and password did not match.');
  const { data, error } = await authClient().auth.signInWithPassword({ email: key, password });
  if (error || !data.user) throw invalid;
  const { data: admin } = await db().from('admin_users').select('id, email, name, role, active').eq('id', data.user.id).maybeSingle();
  if (!admin || !admin.active) throw invalid;
  const token = newToken();
  must(await db().from('admin_sessions').insert({ token_hash: sha256(token), admin_id: admin.id, expires_at: new Date(Date.now() + ADMIN_SESSION_SECONDS * 1000).toISOString() }), 'admin session');
  await db().from('admin_sessions').delete().lt('expires_at', new Date().toISOString());
  ctx.setCookie(getServerEnv().adminSessionCookie, token, ADMIN_SESSION_SECONDS);
  return { mfaRequired: false, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } };
});
route('POST', '/admin/auth/mfa', () => { throw new HttpError(400, 'mfa_not_enabled', 'Multi-factor authentication is not enabled.'); });
route('POST', '/admin/auth/logout', async ctx => {
  const name = getServerEnv().adminSessionCookie;
  if (ctx.cookies[name]) await db().from('admin_sessions').delete().eq('token_hash', sha256(ctx.cookies[name]));
  ctx.setCookie(name, '', 0);
  return null;
});
route('GET', '/admin/auth/me', async ctx => ({ admin: await requireAdmin(ctx) }));

// ───────────── dashboard ─────────────

route('GET', '/admin/dashboard/summary', async ctx => {
  await requireAdmin(ctx, 'dashboard');
  const settings = await getSettingsRow();
  const stats = must(await db().rpc('dashboard_stats', { p_low: settings.low_stock_threshold }), 'dashboard') as Row;
  const lowRows = must(await db().from('product_variants').select('sku, size, stock, products!inner(id, name, status)').eq('active', true).eq('products.status', 'active').gt('stock', 0).lte('stock', settings.low_stock_threshold), 'low stock') as Row[];
  const lowStock = summarizeLowStock(lowRows.map(row => ({ productId: row.products.id, name: row.products.name, size: row.size, sku: row.sku, stock: row.stock })), settings.low_stock_threshold);
  const recent = must(await db().from('orders').select(ORDER_SELECT).order('created_at', { ascending: false }).limit(5), 'recent orders') as Row[];
  return {
    orderCount: stats.order_count, grossRevenue: Number(stats.gross_revenue), productCount: stats.product_count, lowStockCount: lowStock.count, lowStockItems: lowStock.items,
    newArrivalCount: stats.new_arrival_count, newLeadCount: stats.new_lead_count, pendingReviewCount: stats.pending_review_count,
    orderCountDeltaPercent: stats.order_delta === null ? null : Number(stats.order_delta), revenueDeltaPercent: stats.revenue_delta === null ? null : Number(stats.revenue_delta),
    revenueSeries: (stats.series as Row[]).map(point => ({ date: point.date, amount: Number(point.amount) })), recentOrders: recent.map(toOrder),
  };
});

// ───────────── products ─────────────


async function adminProductById(id: string) {
  const [{ data }, settings] = await Promise.all([db().from('products').select(PRODUCT_SELECT).eq('id', id).maybeSingle(), getSettingsRow()]);
  if (!data) throw new HttpError(404, 'not_found', 'Product not found.');
  const [pub] = await toProducts([data], settings);
  return toAdminProduct(data, settings, pub);
}

async function saveProduct(input: z.infer<typeof adminProductInputSchema>, adminId: string, id?: string) {
  if (input.stockMessage?.trim()) {
    // The message column arrives with migration 0004; refuse (rather than silently drop the text) if it has not been applied yet.
    const probe = await db().from('products').select('stock_message').limit(1);
    if (probe.error?.code === '42703' || /stock_message/.test(probe.error?.message ?? '')) {
      throw new HttpError(503, 'migration_required', 'Custom stock messages need database migration 0004. Ask the developer to apply it.');
    }
  }
  if ((input.stockMessageMode && input.stockMessageMode !== 'none') || input.stockMessageNumber != null) {
    const probe = await db().from('products').select('stock_message_mode, stock_message_number').limit(1);
    if (probe.error?.code === '42703' || /stock_message_(mode|number)/.test(probe.error?.message ?? '')) {
      throw new HttpError(503, 'migration_required', 'Stock message modes need database migration 0008. Ask the developer to apply it.');
    }
  }
  if (input.returnable === false) {
    const probe = await db().from('products').select('returnable').limit(1);
    if (probe.error) throw new HttpError(503, 'migration_required', 'The returnable setting needs database migration 0005. Ask the developer to apply it.');
  }
  if (input.exchangeable === false || input.codEnabled === false || input.onlinePaymentEnabled === false) {
    const probe = await db().from('products').select('exchangeable, cod_enabled, online_payment_enabled').limit(1);
    if (probe.error?.code === '42703' || /exchangeable|cod_enabled|online_payment_enabled/.test(probe.error?.message ?? '')) {
      throw new HttpError(503, 'migration_required', 'Product policy and payment method controls require database migration 0006. Please apply supabase/migrations/0006_product_policies_payments.sql.');
    }
  }
  if (!id && !input.variants) throw new HttpError(422, 'validation_failed', 'A new product needs at least one size with stock.', { variants: ['Required'] });
  if (id && input.variants && !input.expectedStock) throw new HttpError(422, 'validation_failed', 'Stock changes must include the stock you saw when you opened the product. Refresh and try again.', { variants: ['Stock snapshot missing'] });
  if (id && !input.variants) {
    // A save without stock relies on the migration-0008 save_product (it skips the variant loop). The previous function would deactivate every size, so refuse instead.
    const probe = await db().from('products').select('stock_message_mode').limit(1);
    if (probe.error) throw new HttpError(503, 'migration_required', 'Saving products now requires database migration 0008. Ask the developer to apply it.');
  }
  const oldImages: string[] = id ? ((await db().from('products').select('images').eq('id', id).maybeSingle()).data?.images ?? []) : [];
  const { data, error } = await db().rpc('save_product', { p: productPayload(input, id), p_actor: adminId });
  if (error) {
    if (isUnique(error, 'products_slug_key')) throw new HttpError(409, 'slug_taken', 'Another product already uses that URL slug.', { slug: ['Slug already in use'] });
    if (isUnique(error, 'sku')) throw new HttpError(409, 'sku_taken', 'A SKU is already used by another product.', { variants: ['SKU already in use'] });
    if (error.code === '23503') throw new HttpError(422, 'validation_failed', 'Unknown category.', { categoryId: ['Unknown category'] });
    if ((error.message ?? '').includes('not_found')) throw new HttpError(404, 'not_found', 'Product not found.');
    const known = saveProductError(error);
    if (known) throw known;
    console.error('[backend] save_product', error.message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  const updates: Record<string, boolean> = {};
  if (typeof input.returnable === 'boolean') updates.returnable = input.returnable;
  if (typeof input.exchangeable === 'boolean') updates.exchangeable = input.exchangeable;
  if (typeof input.codEnabled === 'boolean') updates.cod_enabled = input.codEnabled;
  if (typeof input.onlinePaymentEnabled === 'boolean') updates.online_payment_enabled = input.onlinePaymentEnabled;
  if (Object.keys(updates).length > 0) {
    const result = await db().from('products').update(updates).eq('id', data as string);
    if (result.error) {
      if (result.error.code === '42703') {
        throw new HttpError(503, 'migration_required', 'Product policy and payment method controls require database migration 0006. Please apply supabase/migrations/0006_product_policies_payments.sql.');
      }
      console.error('[backend] product policy update', result.error.message);
      throw new HttpError(500, 'server_error', 'Failed to update product policies.');
    }
  }
  const kept = new Set(input.images.map(storedImage));
  await removeStorageObjects(oldImages.filter(path => !kept.has(path)));
  return adminProductById(data as string);
}

route('GET', '/admin/products', async ctx => {
  await requireAdmin(ctx, 'catalog');
  const { page, pageSize } = pageParams(ctx.url, 200);
  const settings = await getSettingsRow();
  const { data, error, count } = await db().from('products').select(PRODUCT_SELECT, { count: 'exact' }).order('created_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  const rows = (data ?? []) as Row[];
  const pub = await toProducts(rows, settings);
  return { items: rows.map((row, index) => toAdminProduct(row, settings, pub[index])), total: count ?? 0, page, pageSize };
});
route('POST', '/admin/products/bulk-flags', async ctx => {
  await requireAdmin(ctx, 'catalog');
  const { flag, value } = await ctx.body(bulkFlagRequestSchema);
  const column = { luxe: 'luxe', bestSeller: 'best_seller', newArrival: 'new_arrival' }[flag];
  must(await db().from('products').update({ [column]: value, updated_at: new Date().toISOString() }).not('id', 'is', null), 'bulk flags');
  return null;
});
route('POST', '/admin/products', async ctx => {
  const admin = await requireAdmin(ctx, 'catalog');
  return json(await saveProduct(await ctx.body(adminProductInputSchema), admin.id), 201);
});
route('PUT', '/admin/products/:id', async ctx => {
  const admin = await requireAdmin(ctx, 'catalog');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Product not found.');
  return saveProduct(await ctx.body(adminProductInputSchema), admin.id, ctx.params.id);
});
route('DELETE', '/admin/products/:id', async ctx => {
  await requireAdmin(ctx, 'catalog');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Product not found.');
  const { data: product } = await db().from('products').select('id, images').eq('id', ctx.params.id).maybeSingle();
  if (!product) throw new HttpError(404, 'not_found', 'Product not found.');
  const { error } = await db().from('products').delete().eq('id', product.id);
  if (error?.code === '23503') throw new HttpError(409, 'product_has_orders', 'This product has orders. Set it to draft instead of deleting it.');
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  await removeStorageObjects(product.images);
  return null;
});

// ───────────── categories ─────────────

route('GET', '/admin/categories', async ctx => {
  await requireAdmin(ctx, 'catalog');
  return { items: (must(await db().from('categories').select('*').order('sort_order'), 'categories') as Row[]).map(categoryDto) };
});
// Slugs the storefront already resolves as collections (see /collections/[slug]); a category using one would be unreachable.
const RESERVED_CATEGORY_SLUGS = ['all', 'best-sellers', 'new-arrivals', 'one-2-1-eight-luxe', 'layering-edit'];
route('POST', '/admin/categories', async ctx => {
  await requireAdmin(ctx, 'catalog');
  const input = await ctx.body(adminCategoryCreateSchema);
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw new HttpError(422, 'validation_failed', 'Enter a URL name using letters or numbers.', { slug: ['Required'] });
  if (RESERVED_CATEGORY_SLUGS.includes(slug)) throw new HttpError(422, 'validation_failed', 'That URL is reserved for a built-in collection. Choose another.', { slug: ['Reserved'] });
  const { data: last } = await db().from('categories').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const { data, error } = await db().from('categories').insert({ slug, name: input.name, image: storedImage(input.image), active: input.active, sort_order: (last?.sort_order ?? 0) + 1 }).select('*').single();
  if (error) {
    if (isUnique(error)) throw new HttpError(409, 'slug_taken', 'Another category already uses that URL.', { slug: ['Already in use'] });
    console.error('[backend] create category', error.message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  return json(categoryDto(data as Row), 201);
});
route('PUT', '/admin/categories/:id', async ctx => {
  await requireAdmin(ctx, 'catalog');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Category not found.');
  const input = await ctx.body(adminCategoryUpdateSchema);
  const { data: old } = await db().from('categories').select('image').eq('id', ctx.params.id).maybeSingle();
  if (!old) throw new HttpError(404, 'not_found', 'Category not found.');
  // Slug is stable by design: renaming a category must not break URLs or product links.
  const row = must(await db().from('categories').update({ name: input.name, image: storedImage(input.image), active: input.active }).eq('id', ctx.params.id).select('*').single(), 'category') as Row;
  if (old.image !== row.image) await removeStorageObjects([old.image]);
  return categoryDto(row);
});

route('DELETE', '/admin/categories/:id', async ctx => {
  await requireAdmin(ctx, 'catalog');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Category not found.');
  const { data: category } = await db().from('categories').select('id, name, slug, image').eq('id', ctx.params.id).maybeSingle();
  if (!category) throw new HttpError(404, 'not_found', 'Category not found.');
  // Never cascade: products (any status) and banners that still point here must be moved first.
  const { count: products } = await db().from('products').select('id', { count: 'exact', head: true }).eq('category_id', category.id);
  if (products) throw new HttpError(409, 'category_in_use', `“${category.name}” still has ${products} product${products === 1 ? '' : 's'}. Move ${products === 1 ? 'it' : 'them'} to another category first.`);
  const { data: banners } = await db().from('hero_slides').select('title').ilike('href', `%/collections/${category.slug}%`);
  if (banners?.length) throw new HttpError(409, 'category_in_use', `A homepage banner (“${banners[0].title}”) still links to this category. Change its destination first.`);
  const { error } = await db().from('categories').delete().eq('id', category.id);
  if (error?.code === '23503') throw new HttpError(409, 'category_in_use', `“${category.name}” is still referenced by products.`);
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  await removeStorageObjects([category.image]);
  return null;
});

// ───────────── orders ─────────────

route('GET', '/admin/orders/export.csv', async ctx => {
  await requireAdmin(ctx, 'orders');
  const rows = must(await db().from('orders').select('number, created_at, contact, status, payment_status, payment_method, total').order('created_at', { ascending: false }).limit(10_000), 'orders export') as Row[];
  return csv('orders.csv', [['number', 'created_at', 'customer', 'status', 'payment_status', 'payment_method', 'total'], ...rows.map(o => [o.number, o.created_at, o.contact.name, o.status, o.payment_status, o.payment_method, o.total])]);
});
route('GET', '/admin/orders', async ctx => {
  await requireAdmin(ctx, 'orders');
  const { page, pageSize } = pageParams(ctx.url, 200);
  let query = db().from('orders').select(ORDER_SELECT, { count: 'exact' });
  const status = ctx.url.searchParams.get('status');
  if (status) query = query.eq('status', status);
  const q = (ctx.url.searchParams.get('q') ?? '').replace(/[^\p{L}\p{N} -]/gu, '').trim();
  if (q) query = query.or(`number.ilike.%${q}%,contact->>name.ilike.%${q}%,contact->>phone.ilike.%${q}%`);
  // `id` is a stable tie-breaker so rows never repeat or vanish between pages.
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  return { items: await presentOrders((data ?? []) as Row[]), total: count ?? 0, page, pageSize };
});
route('PATCH', '/admin/orders/:id/status', async ctx => {
  const admin = await requireAdmin(ctx, 'orders');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Order not found.');
  const input = await ctx.body(updateOrderStatusSchema);
  const { data, error } = await db().rpc('transition_order', { p_order: ctx.params.id, p_to: input.status, p_actor: admin.id, p_note: input.note ?? null, p_carrier: input.carrier ?? null, p_tracking: input.trackingNumber ?? null, p_url: input.trackingUrl ?? null });
  if (error) {
    const message = error.message ?? '';
    if (message.includes('not_found')) throw new HttpError(404, 'not_found', 'Order not found.');
    if (message.includes('invalid_transition')) throw new HttpError(409, 'invalid_transition', `That status change is not allowed (${(error.details ?? '').replace('->', ' → ')}).`);
    console.error('[backend] transition_order', message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  const [order] = await presentOrders([(await loadOrder(ctx.params.id))!]);
  if ((data as Row).changed && ['processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(order.status)) await sendOrderEmail(orderMailData(order), 'status');
  return order;
});

// ───────────── returns ─────────────

const RETURN_SELECT = '*, return_items(order_item_id, quantity), orders(*, order_items(*), order_status_history(to_status, created_at, note, actor_type))';
route('GET', '/admin/returns', async ctx => {
  await requireAdmin(ctx, 'orders');
  const { page, pageSize } = pageParams(ctx.url, 100);
  const { data, error, count } = await db().from('returns').select(RETURN_SELECT, { count: 'exact' }).order('created_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1);
  if (error) {
    if (/does not exist|schema cache/.test(error.message)) return { items: [], total: 0, page, pageSize };
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  const rows = (data ?? []) as Row[];
  const refunds = rows.length ? (must(await db().from('refunds').select('*').in('return_id', rows.map(r => r.id)), 'refunds') as Row[]) : [];
  const items = rows.map(r => { const order = toOrder(r.orders); return { ...toReturnDto(r, order.lines, order.number, refunds.find(f => f.return_id === r.id)), contact: order.contact }; });
  return { items, total: count ?? 0, page, pageSize };
});
route('PATCH', '/admin/returns/:id', async ctx => {
  const admin = await requireAdmin(ctx, 'orders');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Return not found.');
  const input = await ctx.body(updateReturnSchema);
  const { data, error } = await db().rpc('process_return', { p_return: ctx.params.id, p_to: input.status, p_actor: admin.id, p_note: input.note ?? null, p_restock: input.restock ?? false, p_ref: input.refundReference ?? null });
  if (error) {
    const message = error.message ?? '';
    if (message.includes('not_found')) throw new HttpError(404, 'not_found', 'Return not found.');
    if (message.includes('invalid_transition')) throw new HttpError(409, 'invalid_transition', `That return status change is not allowed (${(error.details ?? '').replace('->', ' → ')}).`);
    if (message.includes('refund_reference_required')) throw new HttpError(422, 'refund_reference_required', 'Enter the refund reference (bank/UPI/provider ID) to confirm the money was actually refunded.', { refundReference: ['Required'] });
    if (message.includes('refund_exceeds_paid')) throw new HttpError(409, 'refund_exceeds_paid', 'This refund would exceed the amount paid for the order.');
    console.error('[backend] process_return', message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  const { data: row } = await db().from('returns').select(RETURN_SELECT).eq('id', ctx.params.id).single();
  const order = toOrder(row!.orders);
  const refund = (await db().from('refunds').select('*').eq('return_id', ctx.params.id).maybeSingle()).data ?? undefined;
  const dto = { ...toReturnDto(row!, order.lines, order.number, refund), contact: order.contact };
  if ((data as Row).changed) await sendReturnEmail({ id: dto.id, number: dto.number, orderNumber: order.number, status: dto.status, to: order.contact.email, name: order.contact.name, trackUrl: trackingUrl(order.id), refundAmount: dto.refund?.amount, refundReference: dto.refund?.reference, note: input.note });
  return dto;
});

// ───────────── reviews ─────────────

const reviewDto = (r: Row) => ({ id: r.id, productId: r.product_id, productName: r.products?.name ?? 'Removed product', author: r.author, rating: r.rating, title: r.title, body: r.body, status: r.status, createdAt: r.created_at, verifiedPurchase: r.verified_purchase });
route('GET', '/admin/reviews', async ctx => {
  await requireAdmin(ctx, 'reviews');
  const { page, pageSize } = pageParams(ctx.url, 200);
  let query = db().from('reviews').select('*, products(name)', { count: 'exact' });
  const status = ctx.url.searchParams.get('status');
  if (status && ['pending', 'published', 'hidden'].includes(status)) query = query.eq('status', status);
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  return { items: ((data ?? []) as Row[]).map(reviewDto), total: count ?? 0, page, pageSize };
});
route('PATCH', '/admin/reviews/:id', async ctx => {
  await requireAdmin(ctx, 'reviews');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Review not found.');
  const { status } = await ctx.body(updateReviewStatusSchema);
  const { data } = await db().from('reviews').update({ status }).eq('id', ctx.params.id).select('*, products(name)').maybeSingle();
  if (!data) throw new HttpError(404, 'not_found', 'Review not found.');
  return reviewDto(data);
});

// ───────────── leads ─────────────

const leadDto = (r: Row) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, type: r.type, quantity: r.quantity, message: r.message, status: r.status, createdAt: r.created_at });
route('GET', '/admin/leads/export.csv', async ctx => {
  await requireAdmin(ctx, 'leads');
  const rows = must(await db().from('leads').select('*').order('created_at', { ascending: false }).limit(10_000), 'leads export') as Row[];
  return csv('leads.csv', [['id', 'created_at', 'name', 'email', 'phone', 'type', 'quantity', 'status', 'message'], ...rows.map(l => [l.id, l.created_at, l.name, l.email, l.phone, l.type, l.quantity, l.status, l.message])]);
});
route('GET', '/admin/leads', async ctx => {
  await requireAdmin(ctx, 'leads');
  const { page, pageSize } = pageParams(ctx.url, 200);
  let query = db().from('leads').select('*', { count: 'exact' });
  const status = ctx.url.searchParams.get('status');
  if (status && ['new', 'contacted', 'qualified', 'closed'].includes(status)) query = query.eq('status', status);
  const q = (ctx.url.searchParams.get('q') ?? '').replace(/[^\p{L}\p{N} @.-]/gu, '').trim();
  if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id').range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  return { items: ((data ?? []) as Row[]).map(leadDto), total: count ?? 0, page, pageSize };
});
route('PATCH', '/admin/leads/:id', async ctx => {
  const admin = await requireAdmin(ctx, 'leads');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Enquiry not found.');
  const { status } = await ctx.body(updateLeadStatusSchema);
  const { data } = await db().from('leads').update({ status }).eq('id', ctx.params.id).select('*').maybeSingle();
  if (!data) throw new HttpError(404, 'not_found', 'Enquiry not found.');
  await db().from('lead_activity').insert({ lead_id: data.id, actor_id: admin.id, kind: 'status', note: status });
  return leadDto(data);
});

// ───────────── content / settings / pages ─────────────

route('GET', '/admin/content', async ctx => {
  await requireAdmin(ctx, 'content');
  const [settings, slides] = await Promise.all([getSettingsRow(), db().from('hero_slides').select('*').order('sort_order')]);
  return { settings: toSettings(settings), heroSlides: (must(slides, 'hero') as Row[]).map(heroDto) };
});
route('PUT', '/admin/content/settings', async ctx => {
  await requireAdmin(ctx, 'settings');
  const s = await ctx.body(storeSettingsSchema);
  const row = must(await db().from('store_settings').update({
    brand_name: s.brandName, brand_line: s.brandLine, promo_text: s.promoText, announcement_enabled: s.announcementEnabled, free_shipping_threshold: s.freeShippingThreshold,
    shipping_fee: s.shippingFee, low_stock_threshold: s.lowStockThreshold, return_policy: s.returnPolicy, seo_title: s.seoTitle, seo_description: s.seoDescription,
    contact_email: s.contactEmail, contact_phone: s.contactPhone, instagram_url: s.instagramUrl ?? null, whatsapp_number: s.whatsappNumber ?? null,
    product_offer_code: s.productOfferCode ?? null, product_offer_text: s.productOfferText ?? null, updated_at: new Date().toISOString(),
  }).eq('id', 1).select('*').single(), 'settings') as Row;
  return toSettings(row);
});
route('PUT', '/admin/content/hero-slides/:id', async ctx => {
  await requireAdmin(ctx, 'content');
  if (!isUuid(ctx.params.id)) throw new HttpError(404, 'not_found', 'Slide not found.');
  const s = await ctx.body(adminHeroSlideUpdateSchema);
  const { data: old } = await db().from('hero_slides').select('desktop_image, mobile_image').eq('id', ctx.params.id).maybeSingle();
  if (!old) throw new HttpError(404, 'not_found', 'Slide not found.');
  const row = must(await db().from('hero_slides').update({ kicker: s.kicker, title: s.title, body: s.body, desktop_image: storedImage(s.desktopImage), mobile_image: storedImage(s.mobileImage), cta: s.cta, href: s.href, active: s.active }).eq('id', ctx.params.id).select('*').single(), 'slide') as Row;
  await removeStorageObjects([old.desktop_image, old.mobile_image].filter(path => path !== row.desktop_image && path !== row.mobile_image));
  return heroDto(row);
});

const pageDto = (r: Row) => ({ slug: r.slug, title: r.title, body: r.body, published: r.published, updatedAt: r.updated_at });
route('GET', '/admin/pages', async ctx => {
  await requireAdmin(ctx, 'content');
  return { items: (must(await db().from('legal_pages').select('*').order('slug'), 'pages') as Row[]).map(pageDto) };
});
route('PUT', '/admin/pages/:slug', async ctx => {
  await requireAdmin(ctx, 'content');
  if (!/^[a-z0-9-]{1,60}$/.test(ctx.params.slug)) throw new HttpError(422, 'validation_failed', 'Invalid page slug.');
  const input = await ctx.body(adminPageInputSchema);
  return pageDto(must(await db().from('legal_pages').upsert({ slug: ctx.params.slug, ...input, updated_at: new Date().toISOString() }).select('*').single(), 'page') as Row);
});
route('DELETE', '/admin/pages/:slug', async ctx => {
  await requireAdmin(ctx, 'content');
  must(await db().from('legal_pages').delete().eq('slug', ctx.params.slug), 'page');
  return null;
});

// ───────────── image uploads (Supabase Storage) ─────────────

const MAX_UPLOAD_BYTES = MAX_IMAGE_UPLOAD_BYTES;

/** Identifies the real image type from magic bytes; the browser-supplied MIME type and filename are ignored. */
export function sniffImage(bytes: Uint8Array): { ext: string; mime: string } | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { ext: 'webp', mime: 'image/webp' };
  if (at(4, 0x66, 0x74, 0x79, 0x70) && [[0x61, 0x76, 0x69, 0x66], [0x61, 0x76, 0x69, 0x73]].some(brand => at(8, ...brand))) return { ext: 'avif', mime: 'image/avif' };
  return null;
}

route('POST', '/admin/uploads', async ctx => {
  await requireAdmin(ctx, 'catalog');
  const declared = Number(ctx.req.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, 'file_too_large', `Images must be ${MAX_IMAGE_UPLOAD_LABEL} or smaller.`);
  let form: FormData;
  try { form = await ctx.req.formData(); } catch { throw new HttpError(400, 'invalid_upload', 'Send the image as multipart form data in a "file" field.'); }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'invalid_upload', 'Send the image as multipart form data in a "file" field.');
  if (file.size === 0) throw new HttpError(422, 'invalid_image', 'That file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file_too_large', `Images must be ${MAX_IMAGE_UPLOAD_LABEL} or smaller.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) throw new HttpError(422, 'invalid_image', 'Only JPEG, PNG, WebP or AVIF images are allowed.');
  const path = `uploads/${new Date().getUTCFullYear()}/${String(new Date().getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
  const { error } = await db().storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType: type.mime, cacheControl: '31536000', upsert: false });
  if (error) { console.error('[backend] upload', error.message); throw new HttpError(502, 'upload_failed', 'The image could not be stored. Please try again.'); }
  return json({ path, url: imageUrl(path) }, 201);
});

route('DELETE', '/admin/uploads', async ctx => {
  await requireAdmin(ctx, 'catalog');
  const path = ctx.url.searchParams.get('path') ?? '';
  if (!/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp|avif)$/.test(path)) throw new HttpError(422, 'validation_failed', 'Invalid upload path.');
  const [products, categories, slides] = await Promise.all([
    db().from('products').select('id', { count: 'exact', head: true }).contains('images', [path]),
    db().from('categories').select('id', { count: 'exact', head: true }).eq('image', path),
    db().from('hero_slides').select('id', { count: 'exact', head: true }).or(`desktop_image.eq.${path},mobile_image.eq.${path}`),
  ]);
  if ((products.count ?? 0) + (categories.count ?? 0) + (slides.count ?? 0) > 0) throw new HttpError(409, 'image_in_use', 'That image is still used by a product, category or banner.');
  await removeStorageObjects([path]);
  return null;
});

/** Removes uploaded files older than 24h that no product, category or banner references (abandoned/failed saves). */
route('POST', '/admin/uploads/cleanup', async ctx => {
  await requireAdmin(ctx, 'catalog');
  const referenced = new Set<string>();
  for (const r of must(await db().from('products').select('images'), 'refs') as Row[]) r.images.forEach((p: string) => referenced.add(p));
  for (const r of must(await db().from('categories').select('image'), 'refs') as Row[]) referenced.add(r.image);
  for (const r of must(await db().from('hero_slides').select('desktop_image, mobile_image'), 'refs') as Row[]) { referenced.add(r.desktop_image); referenced.add(r.mobile_image); }
  const orphans: string[] = [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const walk = async (prefix: string): Promise<void> => {
    const { data } = await db().storage.from(MEDIA_BUCKET).list(prefix, { limit: 1000 });
    for (const entry of data ?? []) {
      const full = `${prefix}/${entry.name}`;
      if (entry.id === null) await walk(full);
      else if (isStoragePath(full) && !referenced.has(full) && Date.parse(entry.created_at ?? '') < cutoff) orphans.push(full);
    }
  };
  await walk('uploads');
  for (let i = 0; i < orphans.length; i += 100) await removeStorageObjects(orphans.slice(i, i + 100));
  return { removed: orphans.length };
});
