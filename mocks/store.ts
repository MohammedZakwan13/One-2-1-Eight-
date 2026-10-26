/**
 * In-memory mock backend (business logic).
 *
 * DEVELOPMENT / TEST ONLY. It is reachable solely when `API_MODE=mock`, which `lib/env.ts`
 * refuses to enable outside `APP_ENV=development|test`. It exists so the UI can be developed
 * and end-to-end tested before the real backend exists. It implements the contract in
 * `openapi/openapi.yaml`; it is NOT a reference for production behaviour (no persistence,
 * no real payments, no real SMS, single process).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AdminProduct, AdminProductInput, AdminReview, Cart, Category, Collection, HeroSlide, Order, OrderStatus, PaymentStatus, Product, StoreSettings,
} from '@/lib/api/schemas';
import { SEED_CATEGORIES, SEED_HERO, SEED_PRODUCTS, SEED_REVIEWS, SEED_SETTINGS } from '@/mocks/seed-data';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fieldErrors?: Record<string, string[]>) {
    super(message);
  }
}

type VariantRecord = { id: string; sku: string; size: string; stock: number };
export type ProductRecord = {
  id: string; slug: string; name: string; categoryId: string; price: number; compareAt: number; color: string; colorHex: string;
  badge: string | null; images: string[]; fit: string; material: string; description: string;
  bestSeller: boolean; newArrival: boolean; luxe: boolean; status: 'active' | 'draft'; variants: VariantRecord[]; updatedAt: string;
};
export type ReviewRecord = {
  id: string; productId: string; author: string; rating: number; title: string; body: string;
  status: 'pending' | 'published' | 'hidden'; createdAt: string; verifiedPurchase: boolean; customerId: string | null;
};
type CartRecord = { id: string; lines: { id: string; variantId: string; quantity: number }[]; couponCode: string | null };
export type OrderRecord = Order & { customerId: string | null; lookupToken: string; paymentId: string; provider: string; cartId: string | null };
type CustomerRecord = { id: string; phone: string; name: string | null; email: string | null };
type LeadRecord = { id: string; name: string; email: string; phone: string; type: string; quantity: string; message: string; status: 'new' | 'contacted' | 'qualified' | 'closed'; createdAt: string };

export type MockState = {
  products: ProductRecord[];
  categories: Category[];
  heroSlides: HeroSlide[];
  settings: StoreSettings;
  reviews: ReviewRecord[];
  carts: Map<string, CartRecord>;
  orders: OrderRecord[];
  orderSequence: number;
  idempotency: Map<string, { fingerprint: string; response: { order: Order; payment: { id: string; provider: string; status: PaymentStatus; action: unknown }; lookupToken: string } }>;
  customers: CustomerRecord[];
  customerSessions: Map<string, string>;
  otpRequests: Map<string, { phone: string; attempts: number; expiresAt: number }>;
  adminSessions: Set<string>;
  leads: LeadRecord[];
  subscriptions: Set<string>;
  failedLogins: Map<string, number>;
};

const COLLECTIONS: Collection[] = [
  { slug: 'best-sellers', title: 'Best sellers', description: 'The pieces customers come back for.' },
  { slug: 'new-arrivals', title: 'New arrivals', description: 'The latest fits and fresh colour stories.' },
  { slug: 'one-2-1-eight-luxe', title: 'ONE 2 1 EIGHT LUXE', description: 'Elevated textures, refined details and quieter statements.' },
  { slug: 'layering-edit', title: 'The layering edit', description: 'Considered layers for every day.' },
];
export const LAYERING_CATEGORIES = ['hoodie', 'sweatshirt', 'drop-shoulder'];
export const listCollections = () => COLLECTIONS;

const DAY = 24 * 60 * 60 * 1000;
const now = () => new Date().toISOString();

function seedProducts(categories: Category[]): ProductRecord[] {
  return SEED_PRODUCTS.map(seed => {
    const category = categories.find(item => item.name === seed.category);
    const perSize = Math.floor(seed.stock / seed.sizes.length);
    const remainder = seed.stock - perSize * seed.sizes.length;
    return {
      id: seed.id, slug: seed.slug, name: seed.name, categoryId: category?.id ?? categories[0].id, price: seed.price, compareAt: seed.compareAt,
      color: seed.color, colorHex: seed.colorHex, badge: seed.badge ?? null, images: [...seed.images], fit: seed.fit, material: seed.material,
      description: seed.description, bestSeller: seed.bestSeller, newArrival: seed.newArrival, luxe: seed.luxe, status: 'active' as const,
      variants: seed.sizes.map((size, index) => ({ id: `${seed.id}-${size.toLowerCase()}`, sku: `${seed.slug.slice(0, 18).toUpperCase()}-${size}`, size, stock: perSize + (index === 0 ? remainder : 0) })),
      updatedAt: now(),
    };
  });
}

function seedReviews(products: ProductRecord[]): ReviewRecord[] {
  const base: ReviewRecord[] = SEED_REVIEWS.map((review, index) => {
    const product = products.find(item => item.name === review.product) ?? products[index % products.length];
    return {
      id: review.id, productId: product.id, author: review.customer, rating: review.rating, title: 'Dev sample review', body: review.text,
      status: review.status === 'Published' ? 'published' : 'pending', createdAt: new Date(Date.now() - (index + 3) * DAY).toISOString(), verifiedPurchase: false, customerId: null,
    };
  });
  // A few clearly-labelled development reviews so the review UI is exercisable locally.
  for (const [index, product] of products.slice(0, 4).entries()) {
    base.push({ id: `dev-r-${index}`, productId: product.id, author: 'Dev reviewer', rating: 5 - (index % 2), title: 'Dev sample review', body: 'Sample review text for local development only.', status: 'published', createdAt: new Date(Date.now() - (index + 1) * DAY).toISOString(), verifiedPurchase: index % 2 === 0, customerId: null });
  }
  return base;
}

export function createInitialState(): MockState {
  const categories: Category[] = SEED_CATEGORIES.map(category => ({ ...category }));
  const products = seedProducts(categories);
  const state: MockState = {
    products, categories,
    heroSlides: SEED_HERO.map(slide => ({ ...slide })),
    settings: { ...SEED_SETTINGS, instagramUrl: null, whatsappNumber: null, productOfferCode: 'WELCOME10', productOfferText: 'Enjoy 10% off your first order over ₹1,499.' },
    reviews: seedReviews(products),
    carts: new Map(), orders: [], orderSequence: 1042, idempotency: new Map(), customers: [], customerSessions: new Map(),
    otpRequests: new Map(), adminSessions: new Set(), leads: [], subscriptions: new Set(), failedLogins: new Map(),
  };
  // Seed a few historical orders so the admin screens have content in development.
  const seeds: Array<{ name: string; daysAgo: number; status: OrderStatus; pay: PaymentStatus; items: Array<[string, string, number]> }> = [
    { name: 'Dev Customer A', daysAgo: 4, status: 'delivered', pay: 'paid', items: [['p1', 'M', 2]] },
    { name: 'Dev Customer B', daysAgo: 2, status: 'shipped', pay: 'paid', items: [['p4', 'L', 1]] },
    { name: 'Dev Customer C', daysAgo: 1, status: 'processing', pay: 'cod_pending', items: [['p2', 'M', 1], ['p6', 'L', 1]] },
  ];
  for (const seed of seeds) {
    const lines = seed.items.map(([productId, size, quantity]) => {
      const product = products.find(item => item.id === productId)!;
      const variant = product.variants.find(item => item.size === size)!;
      return { productId, variantId: variant.id, name: product.name, image: product.images[0], size, color: product.color, quantity, unitPrice: product.price, lineTotal: product.price * quantity };
    });
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const shipping = subtotal >= state.settings.freeShippingThreshold ? 0 : 79;
    state.orderSequence += 1;
    state.orders.unshift({
      id: `ord_${state.orderSequence}`, number: `1218-${state.orderSequence}`, status: seed.status, paymentStatus: seed.pay, paymentMethod: seed.pay === 'paid' ? 'upi' : 'cod', currency: 'INR',
      totals: { subtotal, discount: 0, shipping, total: subtotal + shipping }, lines,
      contact: { name: seed.name, phone: '9000000000', email: 'dev@localhost.invalid' },
      shippingAddress: { line1: '1 Dev Street', line2: null, city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
      createdAt: new Date(Date.now() - seed.daysAgo * DAY).toISOString(), customerId: null, lookupToken: randomBytes(16).toString('hex'), paymentId: `pay_${randomUUID()}`, provider: 'mock-gateway', cartId: null,
    });
  }
  return state;
}

const GLOBAL_KEY = '__o218_mock_state__';
type GlobalWithState = typeof globalThis & { [GLOBAL_KEY]?: MockState };
export function getState(): MockState {
  const holder = globalThis as GlobalWithState;
  return (holder[GLOBAL_KEY] ??= createInitialState());
}
export function resetState() {
  (globalThis as GlobalWithState)[GLOBAL_KEY] = createInitialState();
}

// ───────────────────────── mapping ─────────────────────────

const LOW_STOCK_AT = 5;
export const availabilityFor = (stock: number) =>
  stock <= 0 ? { status: 'out_of_stock' as const } : stock <= LOW_STOCK_AT ? { status: 'low_stock' as const, quantity: stock } : { status: 'in_stock' as const };

function reviewStats(state: MockState, productId: string) {
  const published = state.reviews.filter(review => review.productId === productId && review.status === 'published');
  const count = published.length;
  const average = count ? Math.round((published.reduce((sum, review) => sum + review.rating, 0) / count) * 10) / 10 : 0;
  const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const review of published) distribution[String(review.rating) as keyof typeof distribution] += 1;
  return { count, average, distribution, published };
}
export { reviewStats };

function categoryOf(state: MockState, id: string) {
  return state.categories.find(category => category.id === id) ?? state.categories[0];
}

export function toPublicProduct(state: MockState, record: ProductRecord): Product {
  const category = categoryOf(state, record.categoryId);
  const stats = reviewStats(state, record.id);
  return {
    id: record.id, slug: record.slug, name: record.name, category: category.name, categorySlug: category.slug, price: record.price, compareAt: record.compareAt,
    color: record.color, colorHex: record.colorHex, rating: stats.average, reviewCount: stats.count, badge: record.badge, images: record.images, fit: record.fit,
    material: record.material, description: record.description, bestSeller: record.bestSeller, newArrival: record.newArrival, luxe: record.luxe,
    variants: record.variants.map(variant => ({ id: variant.id, sku: variant.sku, size: variant.size, availability: availabilityFor(variant.stock) })),
    updatedAt: record.updatedAt,
  };
}

export function toAdminProduct(state: MockState, record: ProductRecord): AdminProduct {
  const pub = toPublicProduct(state, record);
  return { ...pub, categoryId: record.categoryId, status: record.status, variants: record.variants.map(variant => ({ id: variant.id, sku: variant.sku, size: variant.size, stock: variant.stock, availability: availabilityFor(variant.stock) })) };
}

export function toAdminReview(state: MockState, review: ReviewRecord): AdminReview {
  const product = state.products.find(item => item.id === review.productId);
  return { id: review.id, productId: review.productId, productName: product?.name ?? 'Removed product', author: review.author, rating: review.rating, title: review.title, body: review.body, status: review.status, createdAt: review.createdAt, verifiedPurchase: review.verifiedPurchase };
}

// ───────────────────────── catalogue queries ─────────────────────────

export type ListQuery = { category?: string; collection?: string; q?: string; ids?: string[]; sort?: string; page: number; pageSize: number };

export function queryProducts(state: MockState, query: ListQuery) {
  let items = state.products.filter(product => product.status === 'active');
  if (query.ids?.length) items = items.filter(product => query.ids!.includes(product.id));
  if (query.category) items = items.filter(product => categoryOf(state, product.categoryId).slug === query.category);
  if (query.collection) {
    if (query.collection === 'best-sellers') items = items.filter(product => product.bestSeller);
    else if (query.collection === 'new-arrivals') items = items.filter(product => product.newArrival);
    else if (query.collection === 'one-2-1-eight-luxe') items = items.filter(product => product.luxe);
    else if (query.collection === 'layering-edit') items = items.filter(product => LAYERING_CATEGORIES.includes(categoryOf(state, product.categoryId).slug));
    else items = [];
  }
  if (query.q) {
    // Light stemming so "t-shirts" matches "T-Shirt" – real search belongs to the backend.
    const tokens = query.q.toLowerCase().split(/\s+/).filter(Boolean).map(token => (token.length > 3 ? token.replace(/s$/, '') : token));
    items = items.filter(product => {
      const haystack = `${product.name} ${categoryOf(state, product.categoryId).name} ${product.color} ${product.fit}`.toLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
  }
  const sorted = [...items];
  switch (query.sort) {
    case 'price-low': sorted.sort((a, b) => a.price - b.price); break;
    case 'price-high': sorted.sort((a, b) => b.price - a.price); break;
    case 'rating': sorted.sort((a, b) => reviewStats(state, b.id).average - reviewStats(state, a.id).average); break;
    case 'new': sorted.sort((a, b) => Number(b.newArrival) - Number(a.newArrival)); break;
    default: sorted.sort((a, b) => Number(b.bestSeller) - Number(a.bestSeller));
  }
  const start = (query.page - 1) * query.pageSize;
  return { items: sorted.slice(start, start + query.pageSize).map(product => toPublicProduct(state, product)), total: sorted.length, page: query.page, pageSize: query.pageSize };
}

// ───────────────────────── cart ─────────────────────────

const MAX_LINE_QUANTITY = 20;
const SHIPPING_FEE = 79;
const COUPONS: Record<string, { description: string; apply: (subtotal: number, hasLuxe: boolean) => { discount: number; reason?: string } }> = {
  WELCOME10: { description: '10% off orders over ₹1,499', apply: subtotal => (subtotal >= 1499 ? { discount: Math.round(subtotal * 0.1) } : { discount: 0, reason: `Add ₹${Math.ceil(1499 - subtotal)} more to use this code.` }) },
  LUXE15: { description: '15% off when your bag includes a Luxe piece', apply: (subtotal, hasLuxe) => (hasLuxe ? { discount: Math.round(subtotal * 0.15) } : { discount: 0, reason: 'This code needs a Luxe piece in your bag.' }) },
};

export function findVariant(state: MockState, variantId: string) {
  for (const product of state.products) {
    const variant = product.variants.find(item => item.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

export function getOrCreateCart(state: MockState, cartId: string | null): { cart: CartRecord; created: boolean } {
  const existing = cartId ? state.carts.get(cartId) : undefined;
  if (existing) return { cart: existing, created: false };
  const cart: CartRecord = { id: `cart_${randomUUID()}`, lines: [], couponCode: null };
  state.carts.set(cart.id, cart);
  return { cart, created: true };
}

export function priceCart(state: MockState, cart: CartRecord): Cart {
  const messages: string[] = [];
  const lines: Cart['lines'] = [];
  for (const line of cart.lines) {
    const found = findVariant(state, line.variantId);
    if (!found || found.product.status !== 'active') { messages.push('An item in your bag is no longer available and was removed.'); continue; }
    const { product, variant } = found;
    let quantity = line.quantity;
    let issue: 'out_of_stock' | 'quantity_reduced' | null = null;
    if (variant.stock <= 0) issue = 'out_of_stock';
    else if (quantity > variant.stock) { quantity = variant.stock; issue = 'quantity_reduced'; messages.push(`Only ${variant.stock} of ${product.name} (${variant.size}) are available.`); }
    line.quantity = issue === 'out_of_stock' ? line.quantity : quantity;
    lines.push({
      id: line.id, variantId: variant.id, productId: product.id, slug: product.slug, name: product.name, image: product.images[0], color: product.color, size: variant.size,
      quantity: line.quantity, unitPrice: product.price, compareAt: product.compareAt, lineTotal: product.price * line.quantity, maxQuantity: Math.min(variant.stock, MAX_LINE_QUANTITY), issue,
    });
  }
  cart.lines = cart.lines.filter(line => lines.some(item => item.id === line.id));
  const subtotal = lines.filter(line => line.issue !== 'out_of_stock').reduce((sum, line) => sum + line.lineTotal, 0);
  let discount = 0;
  let coupon: Cart['coupon'] = null;
  if (cart.couponCode && COUPONS[cart.couponCode]) {
    const hasLuxe = lines.some(line => state.products.find(product => product.id === line.productId)?.luxe);
    const result = COUPONS[cart.couponCode].apply(subtotal, Boolean(hasLuxe));
    if (result.discount > 0) { discount = result.discount; coupon = { code: cart.couponCode, description: COUPONS[cart.couponCode].description }; }
    else { cart.couponCode = null; if (result.reason) messages.push(`Coupon removed: ${result.reason}`); }
  }
  const threshold = state.settings.freeShippingThreshold;
  const shipping = subtotal === 0 || subtotal - discount >= threshold ? 0 : SHIPPING_FEE;
  return { id: cart.id, currency: 'INR', lines, coupon, totals: { subtotal, discount, shipping, total: Math.max(0, subtotal - discount + shipping) }, freeShippingThreshold: threshold, messages };
}

export function applyCoupon(state: MockState, cart: CartRecord, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  const definition = COUPONS[code];
  if (!definition) throw new HttpError(422, 'coupon_invalid', 'That code is not available for this bag.');
  const priced = priceCart(state, cart);
  const hasLuxe = priced.lines.some(line => state.products.find(product => product.id === line.productId)?.luxe);
  const result = definition.apply(priced.totals.subtotal, hasLuxe);
  if (result.discount <= 0) throw new HttpError(422, 'coupon_not_applicable', result.reason ?? 'That code is not available for this bag.');
  cart.couponCode = code;
}

// ───────────────────────── orders ─────────────────────────

export function paymentFor(order: OrderRecord) {
  return { id: order.paymentId, provider: order.provider, status: order.paymentStatus };
}

export function createOrderFromCart(state: MockState, cart: CartRecord, input: { contact: Order['contact']; shippingAddress: Order['shippingAddress']; paymentMethod: Order['paymentMethod'] }, customerId: string | null) {
  const priced = priceCart(state, cart);
  if (!priced.lines.length) throw new HttpError(409, 'cart_empty', 'Your bag is empty.');
  const blocked = priced.lines.find(line => line.issue === 'out_of_stock');
  if (blocked) throw new HttpError(409, 'out_of_stock', `${blocked.name} (${blocked.size}) is out of stock. Remove it to continue.`);
  if (priced.messages.some(message => message.startsWith('Only'))) throw new HttpError(409, 'quantity_changed', 'Stock changed while you were checking out. Review your bag and try again.');
  // Reserve (decrement) stock atomically for this single-process mock.
  for (const line of priced.lines) {
    const found = findVariant(state, line.variantId)!;
    found.variant.stock -= line.quantity;
  }
  state.orderSequence += 1;
  const paymentId = `pay_${randomUUID()}`;
  const cod = input.paymentMethod === 'cod';
  const order: OrderRecord = {
    id: `ord_${state.orderSequence}`, number: `1218-${state.orderSequence}`,
    status: cod ? 'confirmed' : 'pending_payment', paymentStatus: cod ? 'cod_pending' : 'pending', paymentMethod: input.paymentMethod, currency: 'INR', totals: priced.totals,
    lines: priced.lines.map(line => ({ productId: line.productId, variantId: line.variantId, name: line.name, image: line.image, size: line.size, color: line.color, quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal })),
    contact: input.contact, shippingAddress: input.shippingAddress, createdAt: now(), customerId, lookupToken: randomBytes(24).toString('hex'), paymentId, provider: 'mock-gateway', cartId: cart.id,
  };
  state.orders.unshift(order);
  cart.lines = [];
  cart.couponCode = null;
  return order;
}

export function restockOrder(state: MockState, order: OrderRecord) {
  for (const line of order.lines) {
    const found = findVariant(state, line.variantId);
    if (found) found.variant.stock += line.quantity;
  }
}

export function toPublicOrder(order: OrderRecord): Order {
  const { customerId: _c, lookupToken: _t, paymentId: _p, provider: _pr, cartId: _ci, ...rest } = order;
  void _c; void _t; void _p; void _pr; void _ci;
  return rest;
}

// ───────────────────────── admin product writes ─────────────────────────

export function writeProduct(state: MockState, input: AdminProductInput, existing?: ProductRecord): ProductRecord {
  if (!state.categories.some(category => category.id === input.categoryId)) throw new HttpError(422, 'validation_failed', 'Unknown category.', { categoryId: ['Unknown category'] });
  if (state.products.some(product => product.slug === input.slug && product.id !== existing?.id)) throw new HttpError(409, 'slug_taken', 'Another product already uses that URL slug.', { slug: ['Slug already in use'] });
  const id = existing?.id ?? `p-${randomUUID().slice(0, 8)}`;
  const variants: VariantRecord[] = input.variants.map(variant => {
    const prior = existing?.variants.find(item => item.size === variant.size);
    return { id: prior?.id ?? `${id}-${variant.size.toLowerCase()}`, sku: variant.sku || prior?.sku || `${input.slug.slice(0, 18).toUpperCase()}-${variant.size}`, size: variant.size, stock: variant.stock };
  });
  return {
    id, slug: input.slug, name: input.name, categoryId: input.categoryId, price: input.price, compareAt: input.compareAt, color: input.color, colorHex: input.colorHex,
    badge: input.badge || null, images: input.images, fit: input.fit, material: input.material, description: input.description,
    bestSeller: input.bestSeller, newArrival: input.newArrival, luxe: input.luxe, status: input.status, variants, updatedAt: now(),
  };
}

// ───────────────────────── CSV (export) ─────────────────────────

/** Escapes a CSV cell and neutralises spreadsheet formula injection (=, +, -, @). */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
