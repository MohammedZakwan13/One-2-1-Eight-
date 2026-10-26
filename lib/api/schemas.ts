import { z } from 'zod';

/**
 * Typed contract for the backend REST API.
 *
 * These schemas are the source of truth for the frontend and are mirrored by
 * `openapi/openapi.yaml` (a unit test keeps the two in step). Every API response is
 * parsed with the matching schema, so a backend that drifts from the contract fails
 * loudly instead of rendering wrong data.
 *
 * Conventions
 * - Money is in INR major units (rupees); numbers may carry up to 2 decimals.
 * - Timestamps are ISO-8601 strings. Dates without time are `YYYY-MM-DD`.
 * - Prices, totals, stock and payment state are always server-authoritative.
 */

// ───────────────────────── primitives ─────────────────────────

/** Site-relative path or https URL only. Rejects `javascript:`, `data:` and protocol-relative URLs. */
export const safeUrl = z.string().min(1).max(2048).refine(
  value => (value.startsWith('/') && !value.startsWith('//')) || /^https:\/\/[^\s]+$/i.test(value),
  { message: 'Must be a site-relative path or an https:// URL' },
);
export const internalPath = z.string().min(1).max(512).regex(/^\/(?!\/)[^\s]*$/, 'Must be a site-relative path');
const id = z.string().min(1).max(128);
const isoDateTime = z.string().min(10).max(40);
const money = z.number().finite().nonnegative();
export const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
export const pincodeSchema = z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit pincode');
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// ───────────────────────── catalogue ─────────────────────────

export const availabilitySchema = z.object({
  status: z.enum(['in_stock', 'low_stock', 'out_of_stock']),
  /** Only present when status is `low_stock` (remaining units). Full stock counts are never exposed publicly. */
  quantity: z.number().int().nonnegative().optional(),
});

export const variantSchema = z.object({
  id,
  sku: z.string().min(1).max(64),
  size: z.string().min(1).max(16),
  availability: availabilitySchema,
});

export const productSchema = z.object({
  id,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(80),
  categorySlug: z.string().min(1).max(80),
  price: money,
  /** 0 (or a value <= price) means there is no compare-at price. */
  compareAt: money,
  color: z.string().min(1).max(60),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Average of published reviews. 0 when reviewCount is 0. */
  rating: z.number().min(0).max(5),
  reviewCount: z.number().int().nonnegative(),
  badge: z.string().max(40).nullish(),
  images: z.array(safeUrl).min(1).max(12),
  fit: z.string().max(120),
  material: z.string().max(160),
  description: z.string().max(5000),
  bestSeller: z.boolean(),
  newArrival: z.boolean(),
  luxe: z.boolean(),
  variants: z.array(variantSchema).min(1),
  updatedAt: isoDateTime,
});
export type Product = z.infer<typeof productSchema>;
export type Variant = z.infer<typeof variantSchema>;

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() });

export const productListSchema = paginated(productSchema);
export type ProductList = z.infer<typeof productListSchema>;

export const categorySchema = z.object({ id, name: z.string().min(1).max(80), slug: z.string().min(1).max(80), image: safeUrl, active: z.boolean() });
export type Category = z.infer<typeof categorySchema>;

export const collectionSchema = z.object({ slug: z.string().min(1).max(80), title: z.string().min(1).max(120), description: z.string().max(500) });
export type Collection = z.infer<typeof collectionSchema>;
export const collectionListSchema = z.object({ items: z.array(collectionSchema) });

export const serviceabilitySchema = z.object({
  pincode: pincodeSchema,
  serviceable: z.boolean(),
  codAvailable: z.boolean(),
  estimatedDays: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).nullable(),
  message: z.string().max(300).nullish(),
});
export type Serviceability = z.infer<typeof serviceabilitySchema>;

export const inventoryAvailabilitySchema = z.object({
  items: z.array(z.object({ variantId: id, sku: z.string(), availability: availabilitySchema })),
});
export type InventoryAvailability = z.infer<typeof inventoryAvailabilitySchema>;

// ───────────────────────── content / CMS ─────────────────────────

export const storeSettingsSchema = z.object({
  brandName: z.string().min(1).max(80),
  brandLine: z.string().max(160),
  promoText: z.string().max(400),
  announcementEnabled: z.boolean(),
  freeShippingThreshold: money,
  returnPolicy: z.string().max(2000),
  seoTitle: z.string().max(120),
  seoDescription: z.string().max(320),
  contactEmail: emailSchema,
  contactPhone: z.string().max(32),
  instagramUrl: z.string().url().startsWith('https://').nullish(),
  whatsappNumber: z.string().regex(/^\d{10,15}$/).nullish(),
  /** Optional offer strip on product pages. The code must exist as a coupon in the backend. */
  productOfferCode: z.string().max(40).nullish(),
  productOfferText: z.string().max(160).nullish(),
});
export type StoreSettings = z.infer<typeof storeSettingsSchema>;

export const heroSlideSchema = z.object({
  id,
  kicker: z.string().max(80),
  title: z.string().max(160),
  body: z.string().max(240),
  desktopImage: safeUrl,
  mobileImage: safeUrl,
  cta: z.string().max(40),
  href: internalPath,
  active: z.boolean(),
});
export type HeroSlide = z.infer<typeof heroSlideSchema>;

export const storefrontContentSchema = z.object({
  settings: storeSettingsSchema,
  heroSlides: z.array(heroSlideSchema),
  categories: z.array(categorySchema),
});
export type StorefrontContent = z.infer<typeof storefrontContentSchema>;

export const legalPageSchema = z.object({ slug: z.string(), title: z.string().max(160), body: z.string().max(100_000), updatedAt: isoDateTime });
export type LegalPage = z.infer<typeof legalPageSchema>;

// ───────────────────────── reviews ─────────────────────────

export const reviewSchema = z.object({
  id,
  author: z.string().min(1).max(70),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(100),
  body: z.string().max(1200),
  createdAt: isoDateTime,
  verifiedPurchase: z.boolean(),
});
export type Review = z.infer<typeof reviewSchema>;

export const reviewSummarySchema = z.object({
  average: z.number().min(0).max(5),
  count: z.number().int().nonnegative(),
  distribution: z.object({
    '1': z.number().int().nonnegative(),
    '2': z.number().int().nonnegative(),
    '3': z.number().int().nonnegative(),
    '4': z.number().int().nonnegative(),
    '5': z.number().int().nonnegative(),
  }),
});
export const reviewListSchema = z.object({ summary: reviewSummarySchema, items: z.array(reviewSchema) });
export type ReviewList = z.infer<typeof reviewListSchema>;

export const createReviewRequestSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(8).max(1200),
  /** Display name. A server may ignore this in favour of the customer profile. */
  authorName: z.string().trim().min(1).max(70),
});
export type CreateReviewRequest = z.infer<typeof createReviewRequestSchema>;
export const createReviewResponseSchema = z.object({ id, status: z.enum(['pending', 'published']), message: z.string().max(300).nullish() });
export type CreateReviewResponse = z.infer<typeof createReviewResponseSchema>;

// ───────────────────────── customer auth ─────────────────────────

export const customerSchema = z.object({ id, phone: phoneSchema, name: z.string().max(120).nullish(), email: z.string().email().nullish() });
export type Customer = z.infer<typeof customerSchema>;

export const otpRequestSchema = z.object({ phone: phoneSchema });
export const otpRequestResponseSchema = z.object({ requestId: id, expiresInSeconds: z.number().int().positive(), resendAfterSeconds: z.number().int().nonnegative() });
export const otpVerifySchema = z.object({ requestId: id, phone: phoneSchema, otp: z.string().regex(/^\d{6}$/) });
export const sessionSchema = z.object({ customer: customerSchema });
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

// ───────────────────────── cart / pricing ─────────────────────────

export const cartLineSchema = z.object({
  id,
  variantId: id,
  productId: id,
  slug: z.string(),
  name: z.string(),
  image: safeUrl,
  color: z.string(),
  size: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: money,
  compareAt: money,
  lineTotal: money,
  /** Server-side cap for this line (available stock or purchase limit). */
  maxQuantity: z.number().int().nonnegative(),
  issue: z.enum(['out_of_stock', 'quantity_reduced', 'price_changed']).nullish(),
});
export const cartTotalsSchema = z.object({ subtotal: money, discount: money, shipping: money, total: money });
export const cartSchema = z.object({
  id,
  currency: z.literal('INR'),
  lines: z.array(cartLineSchema),
  coupon: z.object({ code: z.string(), description: z.string().nullish() }).nullable(),
  totals: cartTotalsSchema,
  freeShippingThreshold: money.nullable(),
  /** Human-readable notices from the server (e.g. "Quantity reduced to available stock"). */
  messages: z.array(z.string()),
});
export type Cart = z.infer<typeof cartSchema>;
export type CartLine = z.infer<typeof cartLineSchema>;

export const addCartItemSchema = z.object({ variantId: id, quantity: z.number().int().min(1).max(20) });
export const updateCartItemSchema = z.object({ quantity: z.number().int().min(0).max(20) });
export const applyCouponSchema = z.object({ code: z.string().trim().min(1).max(40) });

// ───────────────────────── orders / payments ─────────────────────────

export const addressSchema = z.object({
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: pincodeSchema,
});
export const contactSchema = z.object({ name: z.string().trim().min(2).max(120), phone: phoneSchema, email: emailSchema });
export const paymentMethodSchema = z.enum(['upi', 'card', 'cod']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const createOrderRequestSchema = z.object({
  contact: contactSchema,
  shippingAddress: addressSchema,
  paymentMethod: paymentMethodSchema,
  acceptedTerms: z.literal(true),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const orderLineSchema = z.object({
  productId: id, variantId: id, name: z.string(), image: safeUrl, size: z.string(), color: z.string(),
  quantity: z.number().int().positive(), unitPrice: money, lineTotal: money,
});
export const orderStatusSchema = z.enum(['pending_payment', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded']);
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export const paymentStatusSchema = z.enum(['unpaid', 'pending', 'paid', 'failed', 'cod_pending', 'refunded']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export const orderSchema = z.object({
  id,
  number: z.string(),
  status: orderStatusSchema,
  paymentStatus: paymentStatusSchema,
  paymentMethod: paymentMethodSchema,
  currency: z.literal('INR'),
  totals: cartTotalsSchema,
  lines: z.array(orderLineSchema),
  contact: contactSchema,
  shippingAddress: addressSchema,
  createdAt: isoDateTime,
});
export type Order = z.infer<typeof orderSchema>;

export const paymentActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('redirect'), url: z.string().url().startsWith('https://') }),
  z.object({ type: z.literal('sdk'), provider: z.string().min(1), payload: z.record(z.string(), z.unknown()) }),
]);
export type PaymentAction = z.infer<typeof paymentActionSchema>;

export const paymentSchema = z.object({
  id,
  provider: z.string(),
  status: paymentStatusSchema,
  /** What the browser must do next to complete payment. null for COD or already-settled payments. */
  action: paymentActionSchema.nullable(),
});
export const createOrderResponseSchema = z.object({
  order: orderSchema,
  payment: paymentSchema,
  /** Opaque token that lets a guest read this order after a payment redirect (also valid for signed-in customers). */
  lookupToken: z.string().min(16),
});
export type CreateOrderResponse = z.infer<typeof createOrderResponseSchema>;
export const verifyPaymentRequestSchema = z.object({ payload: z.record(z.string(), z.unknown()) });
export const orderListSchema = paginated(orderSchema);

// ───────────────────────── newsletter / leads ─────────────────────────

export const newsletterRequestSchema = z.object({ email: emailSchema, consent: z.literal(true) });
export const newsletterResponseSchema = z.object({ status: z.enum(['pending_confirmation', 'subscribed']) });

export const leadRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: z.string().trim().min(7).max(20),
  type: z.string().trim().min(1).max(60),
  quantity: z.string().trim().min(1).max(60),
  message: z.string().trim().max(2000),
});
export type LeadRequest = z.infer<typeof leadRequestSchema>;
export const leadResponseSchema = z.object({ id });

// ───────────────────────── admin ─────────────────────────

export const adminUserSchema = z.object({ id, email: z.string().email(), name: z.string().max(120), role: z.enum(['owner', 'manager', 'content', 'support']) });
export type AdminUser = z.infer<typeof adminUserSchema>;
export const adminLoginRequestSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(256) });
export const adminLoginResponseSchema = z.object({ mfaRequired: z.boolean(), admin: adminUserSchema.nullable() });
export const adminMfaRequestSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const adminMeSchema = z.object({ admin: adminUserSchema });

export const adminVariantSchema = variantSchema.extend({ stock: z.number().int().nonnegative() });
export const adminProductSchema = productSchema.extend({
  categoryId: id,
  status: z.enum(['active', 'draft']),
  variants: z.array(adminVariantSchema).min(1),
});
export type AdminProduct = z.infer<typeof adminProductSchema>;
export const adminProductListSchema = paginated(adminProductSchema);

export const adminProductInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  categoryId: id,
  price: money,
  compareAt: money,
  color: z.string().trim().min(1).max(60),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  badge: z.string().trim().max(40).nullish(),
  images: z.array(safeUrl).min(1).max(12),
  fit: z.string().trim().max(120),
  material: z.string().trim().max(160),
  description: z.string().trim().max(5000),
  bestSeller: z.boolean(),
  newArrival: z.boolean(),
  luxe: z.boolean(),
  status: z.enum(['active', 'draft']),
  variants: z.array(z.object({ size: z.string().trim().min(1).max(16), sku: z.string().trim().max(64).nullish(), stock: z.number().int().min(0).max(100_000) })).min(1),
});
export type AdminProductInput = z.infer<typeof adminProductInputSchema>;

export const adminOrderListSchema = paginated(orderSchema);
export const updateOrderStatusSchema = z.object({ status: orderStatusSchema });

export const adminReviewSchema = z.object({
  id, productId: id, productName: z.string(), author: z.string(), rating: z.number().int().min(1).max(5), title: z.string(), body: z.string(),
  status: z.enum(['pending', 'published', 'hidden']), createdAt: isoDateTime, verifiedPurchase: z.boolean(),
});
export type AdminReview = z.infer<typeof adminReviewSchema>;
export const adminReviewListSchema = paginated(adminReviewSchema);
export const updateReviewStatusSchema = z.object({ status: z.enum(['pending', 'published', 'hidden']) });

export const leadStatusSchema = z.enum(['new', 'contacted', 'qualified', 'closed']);
export const adminLeadSchema = leadRequestSchema.extend({ id, status: leadStatusSchema, createdAt: isoDateTime });
export type AdminLead = z.infer<typeof adminLeadSchema>;
export const adminLeadListSchema = paginated(adminLeadSchema);
export const updateLeadStatusSchema = z.object({ status: leadStatusSchema });

export const adminCategoryUpdateSchema = z.object({ name: z.string().trim().min(1).max(80), image: safeUrl, active: z.boolean() });
export const adminCategoriesSchema = z.object({ items: z.array(categorySchema) });

export const adminContentSchema = z.object({ settings: storeSettingsSchema, heroSlides: z.array(heroSlideSchema) });
export const adminHeroSlideUpdateSchema = heroSlideSchema.omit({ id: true });

export const dashboardSummarySchema = z.object({
  orderCount: z.number().int().nonnegative(),
  grossRevenue: money,
  productCount: z.number().int().nonnegative(),
  lowStockCount: z.number().int().nonnegative(),
  newArrivalCount: z.number().int().nonnegative(),
  newLeadCount: z.number().int().nonnegative(),
  pendingReviewCount: z.number().int().nonnegative(),
  /** Percent change versus the previous period; null when unknown. */
  orderCountDeltaPercent: z.number().nullable(),
  revenueDeltaPercent: z.number().nullable(),
  revenueSeries: z.array(z.object({ date: z.string(), amount: money })),
  recentOrders: z.array(orderSchema).max(10),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const bulkFlagRequestSchema = z.object({ flag: z.enum(['luxe', 'bestSeller', 'newArrival']), value: z.boolean() });

// ───────────────────────── errors / misc ─────────────────────────

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export const csrfTokenSchema = z.object({ token: z.string().min(16) });
export const healthSchema = z.object({ status: z.literal('ok') });
