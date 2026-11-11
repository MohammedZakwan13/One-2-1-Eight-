import { z } from 'zod';
import { parseTrackingUrl } from '@/lib/tracking-url';
import { stockTextError } from '@/lib/inventory';
import { effectiveMediaType } from '@/lib/hero-media';

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
/** An image reference that may be absent: '' means "no image". Never a fake placeholder URL. */
export const optionalImageUrl = z.union([z.literal(''), safeUrl]);
export const internalPath = z.string().min(1).max(512).regex(/^\/(?!\/)[^\s]*$/, 'Must be a site-relative path');
const id = z.string().min(1).max(128);
const isoDateTime = z.string().min(10).max(40);
const money = z.number().finite().nonnegative();
export const phoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
export const pincodeSchema = z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit pincode');
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const paymentMethodSchema = z.enum(['upi', 'card', 'cod']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

// ───────────────────────── catalogue ─────────────────────────

export const availabilitySchema = z.object({
  status: z.enum(['in_stock', 'low_stock', 'out_of_stock']),
  /** Exact units for this size. Present ONLY for products whose stock message mode is 'real'; never for any other product. */
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
  images: z.array(safeUrl).max(12),
  fit: z.string().max(120),
  material: z.string().max(160),
  description: z.string().max(5000),
  bestSeller: z.boolean(),
  newArrival: z.boolean(),
  luxe: z.boolean(),
  /** Admin-written display text for the product page (e.g. "Limited drop"). Pure copy: never derived from, or used as, inventory. */
  stockMessage: z.string().max(160).nullish(),
  /** 'real' = actual per-size stock plus the message; 'custom' = admin-entered display number + message (NOT inventory); 'none' = nothing. Absent on legacy data. */
  stockMessageMode: z.enum(['none', 'real', 'custom']).optional(),
  /** Promotional display number for 'custom' mode only. Never inventory; null/absent in every other mode. */
  stockMessageNumber: z.number().int().min(0).max(100_000).nullish(),
  /** Whether the product can be returned after delivery. Defaults to true for products saved before the setting existed. */
  returnable: z.boolean().optional(),
  /** Whether the product can be exchanged after delivery. */
  exchangeable: z.boolean().optional(),
  /** Whether Cash on Delivery is allowed for this product. */
  codEnabled: z.boolean().optional(),
  /** Whether Online Payment (UPI, Card) is allowed for this product. */
  onlinePaymentEnabled: z.boolean().optional(),
  variants: z.array(variantSchema).min(1),
  updatedAt: isoDateTime,
});
export type Product = z.infer<typeof productSchema>;
export type Variant = z.infer<typeof variantSchema>;

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive() });

export const productListSchema = paginated(productSchema);
export type ProductList = z.infer<typeof productListSchema>;

export const categorySchema = z.object({ id, name: z.string().min(1).max(80), slug: z.string().min(1).max(80), image: optionalImageUrl, active: z.boolean() });
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

export const instagramUrlSchema = z
  .string()
  .trim()
  .url()
  .startsWith('https://')
  .refine(
    value => {
      try {
        const u = new URL(value);
        return (
          u.hostname === 'instagram.com' ||
          u.hostname === 'www.instagram.com' ||
          u.hostname.endsWith('.instagram.com')
        );
      } catch {
        return false;
      }
    },
    { message: 'Must be an HTTPS Instagram URL (e.g. https://www.instagram.com/your-handle)' }
  )
  .nullish();

export const whatsappNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{10,15}$/, 'WhatsApp number must be 10 to 15 digits with country code')
  .nullish();

export const storeSettingsSchema = z.object({
  brandName: z.string().min(1).max(80),
  brandLine: z.string().max(160),
  promoText: z.string().max(400),
  announcementEnabled: z.boolean(),
  freeShippingThreshold: money,
  shippingFee: money,
  /** A size at or below this REAL quantity is low stock (storefront message and admin dashboard). */
  lowStockThreshold: z.number().int().min(0).max(1000),
  returnPolicy: z.string().max(2000),
  seoTitle: z.string().max(120),
  seoDescription: z.string().max(320),
  contactEmail: emailSchema,
  contactPhone: z.string().max(32),
  instagramUrl: instagramUrlSchema,
  whatsappNumber: whatsappNumberSchema,
  /** Optional offer strip on product pages. The code must exist as a coupon in the backend. */
  productOfferCode: z.string().max(40).nullish(),
  productOfferText: z.string().max(160).nullish(),
});
export type StoreSettings = z.infer<typeof storeSettingsSchema>;

const heroMediaType = z.enum(['image', 'video']);
/** A media URL that may be empty (a video without a poster, or a draft that has no media yet). */
const optionalSafeUrl = z.union([z.literal(''), safeUrl]);

/**
 * One hero banner. The original fields keep their names and meaning (`desktopImage` / `mobileImage` stay the still pictures, and become
 * the poster of a video slot). Everything added for video / independent mobile media has a default, so older payloads still parse.
 */
export const heroSlideSchema = z.object({
  id,
  kicker: z.string().max(80),
  title: z.string().max(160),
  body: z.string().max(240),
  desktopImage: optionalSafeUrl,
  mobileImage: optionalSafeUrl,
  cta: z.string().max(40),
  href: internalPath,
  active: z.boolean(),
  desktopMediaType: heroMediaType.default('image'),
  desktopVideo: optionalSafeUrl.default(''),
  mobileMediaType: heroMediaType.default('image'),
  mobileVideo: optionalSafeUrl.default(''),
  useDesktopOnMobile: z.boolean().default(false),
  altText: z.string().max(200).default(''),
  /** Position in the carousel (1-based, set by the server). */
  sortOrder: z.number().int().default(0),
  /** Version stamp used to detect two admins editing the same banner. */
  updatedAt: z.string().default(''),
});
export type HeroSlide = z.infer<typeof heroSlideSchema>;

/**
 * The editable homepage "THE PRIVATE EDIT" band. `image` may be empty (the band then reuses a banner still). The call-to-action needs a label
 * and a site-relative destination; the eyebrow and the two description lines may be left empty and are then simply not shown.
 */
export const luxeFeatureSchema = z.object({
  enabled: z.boolean(),
  image: optionalSafeUrl,
  imageAlt: z.string().trim().max(160),
  eyebrow: z.string().trim().max(60),
  heading: z.string().trim().min(1, 'Add a heading').max(100),
  bodyLine1: z.string().trim().max(120),
  bodyLine2: z.string().trim().max(120),
  ctaLabel: z.string().trim().min(1, 'Add a button label').max(40),
  ctaHref: internalPath,
});
export type LuxeFeature = z.infer<typeof luxeFeatureSchema>;
/** Admin view: `available` is false until database migration 0011 has been applied (saving is then refused with a clear message). */
export const adminLuxeFeatureSchema = z.object({ luxeFeature: luxeFeatureSchema.nullable(), available: z.boolean() });

export const storefrontContentSchema = z.object({
  settings: storeSettingsSchema,
  heroSlides: z.array(heroSlideSchema),
  /** null / absent = the built-in copy. */
  luxeFeature: luxeFeatureSchema.nullish(),
  categories: z.array(categorySchema),
  /** Methods the checkout may offer; online methods appear only when a payment provider is configured. */
  paymentMethods: z.array(paymentMethodSchema).min(1),
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
export const otpRequestResponseSchema = z.object({ requestId: id, expiresInSeconds: z.number().int().positive(), resendAfterSeconds: z.number().int().nonnegative(), widgetId: z.string().min(1), tokenAuth: z.string().min(1) });
export const otpConfigSchema = z.object({ widgetId: z.string().min(1), tokenAuth: z.string().min(1) });
export const otpVerifySchema = z.object({ requestId: id, phone: phoneSchema, accessToken: z.string().min(20).max(4096) });
export const sessionSchema = z.object({ customer: customerSchema });
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;

// ───────────────────────── cart / pricing ─────────────────────────

export const cartLineSchema = z.object({
  id,
  variantId: id,
  productId: id,
  slug: z.string(),
  name: z.string(),
  image: optionalImageUrl,
  color: z.string(),
  size: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: money,
  compareAt: money,
  lineTotal: money,
  /** Server-side cap for this line (available stock or purchase limit). */
  maxQuantity: z.number().int().nonnegative(),
  issue: z.enum(['out_of_stock', 'quantity_reduced', 'price_changed']).nullish(),
  returnable: z.boolean().optional(),
  exchangeable: z.boolean().optional(),
  codEnabled: z.boolean().optional(),
  onlinePaymentEnabled: z.boolean().optional(),
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
  allowedPaymentMethods: z.array(paymentMethodSchema).optional(),
  paymentConflict: z.boolean().optional(),
  codAllowed: z.boolean().optional(),
  onlineAllowed: z.boolean().optional(),
  onlineGatewayConfigured: z.boolean().optional(),
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
export const createOrderRequestSchema = z.object({
  contact: contactSchema,
  shippingAddress: addressSchema,
  paymentMethod: paymentMethodSchema,
  acceptedTerms: z.literal(true),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const orderLineSchema = z.object({
  /** order_items.id: what a return request refers to. */
  id: id.optional(), returnable: z.boolean().optional(), exchangeable: z.boolean().optional(), returnedQuantity: z.number().int().nonnegative().optional(),
  productId: id, variantId: id, name: z.string(), image: optionalImageUrl, size: z.string(), color: z.string(),
  quantity: z.number().int().positive(), unitPrice: money, lineTotal: money,
});
export const orderStatusSchema = z.enum(['pending_payment', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded']);
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export const paymentStatusSchema = z.enum(['unpaid', 'pending', 'paid', 'failed', 'cod_pending', 'refunded']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export const returnStatusSchema = z.enum(['requested', 'approved', 'rejected', 'received', 'refund_pending', 'completed']);
export const refundSchema = z.object({ amount: z.number(), status: z.enum(['pending', 'completed', 'failed']), reference: z.string().nullable(), method: z.string() });
export const returnSchema = z.object({
  id, number: z.string(), orderId: id, orderNumber: z.string(), status: returnStatusSchema, reason: z.string(), adminNote: z.string().nullable(),
  createdAt: isoDateTime, restocked: z.boolean().optional(),
  items: z.array(z.object({ orderItemId: id, name: z.string(), size: z.string(), quantity: z.number().int().positive() })),
  refund: refundSchema.nullable(),
  /** Only on admin responses. */
  contact: z.object({ name: z.string(), phone: z.string(), email: z.string() }).optional(),
});
export type OrderReturn = z.infer<typeof returnSchema>;
export const returnListSchema = paginated(returnSchema);

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
  /** Customer-visible fulfilment timeline. */
  history: z.array(z.object({ status: orderStatusSchema, at: isoDateTime, note: z.string().nullish() })),
  shipment: z.object({ carrier: z.string().nullable(), trackingNumber: z.string().nullable(), trackingUrl: z.string().nullable() }).nullable(),
  /** Server-decided: the customer may cancel (before shipping). */
  cancellable: z.boolean().optional(),
  cancelReason: z.string().nullish(),
  deliveredAt: isoDateTime.nullish(),
  /** Last moment a return can be requested (delivery + window); null until delivered. */
  returnableUntil: isoDateTime.nullish(),
  returns: z.array(returnSchema).optional(),
  refund: refundSchema.nullish(),
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
  /** True while a message written before stock modes existed has not been reviewed by an admin. */
  stockMessageReview: z.boolean().optional(),
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
  /** Optional. Omitted on an update = keep the current images; an explicit [] = remove them all. */
  images: z.array(safeUrl).max(12).optional(),
  fit: z.string().trim().max(120),
  material: z.string().trim().max(160),
  description: z.string().trim().max(5000),
  bestSeller: z.boolean(),
  newArrival: z.boolean(),
  luxe: z.boolean(),
  status: z.enum(['active', 'draft']),
  stockMessage: z.string().trim().max(160).nullish(),
  stockMessageMode: z.enum(['none', 'real', 'custom']).optional(),
  stockMessageNumber: z.number().int().min(0).max(100_000).nullish(),
  returnable: z.boolean().optional(),
  exchangeable: z.boolean().optional(),
  codEnabled: z.boolean().optional(),
  onlinePaymentEnabled: z.boolean().optional(),
  /** Sent ONLY when the admin intentionally changes size stock (or creates a product). Omitted for message/metadata-only saves, which never write inventory. */
  variants: z.array(z.object({ size: z.string().trim().min(1).max(16), sku: z.string().trim().max(64).nullish(), stock: z.number().int().min(0).max(100_000) })).min(1).optional(),
  /** Stock per size as it was when the editor loaded the product. Required with `variants` on updates; the server rejects the update if live stock differs (409 stock_conflict). */
  expectedStock: z.record(z.string().trim().min(1).max(16), z.number().int().min(0).max(100_000)).optional(),
}).refine(data => data.codEnabled !== false || data.onlinePaymentEnabled !== false, {
  message: 'At least one payment method (Cash on Delivery or Online Payment) must be enabled.',
  path: ['paymentMethods'],
}).superRefine((data, ctx) => {
  if (data.stockMessageMode && data.stockMessageMode !== 'none') {
    const problem = stockTextError(data.stockMessage);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ['stockMessage'] });
  }
  // A display number exists only in Custom mode; Real and None never carry one.
  if (data.stockMessageNumber != null && data.stockMessageMode !== 'custom') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A custom display number is only allowed in Custom Stock mode.', path: ['stockMessageNumber'] });
  }
});
export type AdminProductInput = z.infer<typeof adminProductInputSchema>;

export const adminOrderListSchema = paginated(orderSchema);
export const cancelOrderRequestSchema = z.object({ reason: z.string().trim().min(3).max(300) });
export const createReturnRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  items: z.array(z.object({ orderItemId: id, quantity: z.number().int().min(1).max(20) })).min(1).max(20),
});
export type CreateReturnRequest = z.infer<typeof createReturnRequestSchema>;
export const updateReturnSchema = z.object({
  status: z.enum(['approved', 'rejected', 'received', 'refund_pending', 'completed']),
  note: z.string().trim().max(500).nullish(),
  /** Only with status=received: the item was inspected and may be sold again. */
  restock: z.boolean().optional(),
  /** Required with status=completed when money is owed: bank/UPI/provider reference proving the refund was paid. */
  refundReference: z.string().trim().max(120).nullish(),
});
export type UpdateReturn = z.infer<typeof updateReturnSchema>;
export const updateOrderStatusSchema = z.object({
  status: orderStatusSchema,
  note: z.string().trim().max(500).nullish(),
  carrier: z.string().trim().max(80).nullish(),
  trackingNumber: z.string().trim().max(80).nullish(),
  trackingUrl: z.string().trim().url().startsWith('https://').max(500).refine(value => parseTrackingUrl(value).ok, 'Enter a valid https:// tracking link.').nullish(),
});

export type UpdateOrderStatus = z.infer<typeof updateOrderStatusSchema>;

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

export const adminCategoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Optional; derived from the name when omitted. Lower-case words joined by hyphens. */
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case letters, numbers and hyphens').max(60).optional(),
  /** Optional; '' or omitted = no image. */
  image: optionalImageUrl.optional(),
  active: z.boolean(),
});
/** `image` omitted = keep the current image; '' = remove it. */
export const adminCategoryUpdateSchema = z.object({ name: z.string().trim().min(1).max(80), image: optionalImageUrl.optional(), active: z.boolean() });
export const adminCategoriesSchema = z.object({ items: z.array(categorySchema) });

export const adminContentSchema = z.object({ settings: storeSettingsSchema, heroSlides: z.array(heroSlideSchema) });
/**
 * Create / update a banner. A banner that is live (`active`) must have media for every device it is shown on; a draft may be saved
 * incomplete. `expectedUpdatedAt` (updates only) makes the save fail with 409 when someone else changed the banner in the meantime.
 */
export const adminHeroSlideUpdateSchema = heroSlideSchema.omit({ id: true, sortOrder: true, updatedAt: true }).extend({ expectedUpdatedAt: z.string().max(64).optional() }).superRefine((slide, ctx) => {
  if (!slide.active) return;
  // Video is optional: a live banner needs visual media for each device, which is an image or a video. An image-mode slot needs its image;
  // a video-mode slot needs its video; a "video" slot with no video file is simply an image slot (and needs the image).
  const needs = (type: 'image' | 'video', image: string, video: string, path: 'desktop' | 'mobile') => {
    if (effectiveMediaType(type, video) === 'image' && !image) ctx.addIssue({ code: 'custom', path: [`${path}Image`], message: `Add a ${path} image or video before publishing.` });
  };
  needs(slide.desktopMediaType, slide.desktopImage, slide.desktopVideo, 'desktop');
  if (!slide.useDesktopOnMobile) needs(slide.mobileMediaType, slide.mobileImage, slide.mobileVideo, 'mobile');
}).transform(slide => ({
  ...slide,
  // What is stored matches what is shown: a slot without a video file is an image slot, whatever the form said.
  desktopMediaType: effectiveMediaType(slide.desktopMediaType, slide.desktopVideo),
  mobileMediaType: effectiveMediaType(slide.mobileMediaType, slide.mobileVideo),
}));
export type HeroSlideInput = z.input<typeof adminHeroSlideUpdateSchema>;
export const adminHeroOrderSchema = z.object({ ids: z.array(z.uuid()).min(1).max(500) });
export const adminHeroOrderResultSchema = z.object({ items: z.array(heroSlideSchema) });
export const heroVideoUploadResponseSchema = z.object({ path: z.string(), url: safeUrl, warnings: z.array(z.string()).default([]) });

export const dashboardSummarySchema = z.object({
  orderCount: z.number().int().nonnegative(),
  grossRevenue: money,
  productCount: z.number().int().nonnegative(),
  lowStockCount: z.number().int().nonnegative(),
  /** Sizes at or below the low-stock threshold, from the REAL database stock. */
  lowStockItems: z.array(z.object({ productId: id.optional(), name: z.string(), size: z.string(), sku: z.string(), stock: z.number().int().nonnegative() })),
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

export const adminPageSchema = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,60}$/), title: z.string().trim().min(1).max(160), body: z.string().max(100_000), published: z.boolean(), updatedAt: isoDateTime });
export type AdminPage = z.infer<typeof adminPageSchema>;
export const adminPageListSchema = z.object({ items: z.array(adminPageSchema) });
export const adminPageInputSchema = adminPageSchema.omit({ slug: true, updatedAt: true });

export const uploadResponseSchema = z.object({ path: z.string(), url: safeUrl });

export const wishlistSchema = z.object({ productIds: z.array(id) });
export const savedAddressInputSchema = addressSchema.extend({ label: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(120), phone: phoneSchema, isDefault: z.boolean().default(false) });
export type SavedAddressInput = z.input<typeof savedAddressInputSchema>;
export const savedAddressSchema = savedAddressInputSchema.extend({ id });
export const savedAddressListSchema = z.object({ items: z.array(savedAddressSchema) });

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
