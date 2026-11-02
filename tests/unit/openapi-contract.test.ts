import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApi } from '@/lib/api/create-api';
import { createCaller, type TransportRequest } from '@/lib/api/http';
import { backendRoutes } from '@/lib/backend';

type Doc = { paths: Record<string, Record<string, { operationId?: string; security?: Array<Record<string, unknown>>; responses?: unknown }>>; components: Record<string, Record<string, unknown>>; webhooks?: unknown };
const doc = parse(fs.readFileSync(path.join(__dirname, '../../openapi/openapi.yaml'), 'utf8')) as Doc;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations = Object.entries(doc.paths).flatMap(([route, item]) => METHODS.filter(method => item[method]).map(method => ({ key: `${method.toUpperCase()} ${route}`, method, route, op: item[method] })));

const toTemplate = (route: string) => route.replace(/:([A-Za-z]+)/g, '{$1}');
const templateRegex = (route: string) => new RegExp(`^${route.replace(/\{[^}]+\}/g, '[^/]+').replace(/\./g, '\\.')}$`);

describe('OpenAPI document', () => {
  it('is a well-formed 3.1 document with unique operation ids and error handling', () => {
    expect((doc as unknown as { openapi: string }).openapi).toBe('3.1.0');
    const ids = operations.map(item => item.op.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { key, op } of operations) expect(op.responses, key).toBeTruthy();
  });

  it('resolves every $ref', () => {
    const missing: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') {
            const target = value.replace(/^#\//, '').split('/').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], doc);
            if (!target) missing.push(value);
          } else walk(value);
        }
      }
    };
    walk(doc);
    expect(missing).toEqual([]);
  });

  it('requires a CSRF token on every state-changing operation', () => {
    const unprotected = operations.filter(({ method, op }) => method !== 'get' && !(op.security ?? []).some(entry => 'csrf' in entry)).map(item => item.key);
    expect(unprotected).toEqual([]);
  });

  it('protects every admin operation with the admin session', () => {
    const open = operations.filter(({ route, op }) => route.startsWith('/admin/') && route !== '/admin/auth/login' && !(op.security ?? []).some(entry => 'adminSession' in entry)).map(item => item.key);
    expect(open).toEqual([]);
  });
});

describe('implemented backend ⇄ OpenAPI', () => {
  it('implements exactly the documented operations (no undocumented or missing routes)', () => {
    const implemented = new Set(backendRoutes().map(route => `${route.method} ${toTemplate(route.path)}`));
    const documented = new Set(operations.map(item => `${item.method.toUpperCase()} ${item.route}`));
    expect([...implemented].filter(key => !documented.has(key))).toEqual([]);
    expect([...documented].filter(key => !implemented.has(key))).toEqual([]);
  });
});

describe('frontend repositories ⇄ OpenAPI', () => {
  it('only calls endpoints that are documented in the contract', async () => {
    const seen: TransportRequest[] = [];
    const api = createApi(createCaller(async request => {
      seen.push(request);
      return new Response(JSON.stringify({ error: { code: 'x', message: 'x' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }));
    const swallow = (promise: Promise<unknown>) => promise.catch(() => undefined);
    const input = {
      contact: { name: 'Asha', phone: '9876543210', email: 'a@b.co' }, shippingAddress: { line1: '1 St', city: 'C', state: 'S', pincode: '560001' }, paymentMethod: 'cod' as const, acceptedTerms: true as const,
    };
    const product = { name: 'n', slug: 's', categoryId: 'c', price: 1, compareAt: 0, color: 'c', colorHex: '#000000', images: ['/a'], fit: 'f', material: 'm', description: 'd', bestSeller: false, newArrival: false, luxe: false, status: 'active' as const, stockMessage: 'Limited drop', variants: [{ size: 'M', stock: 1 }] };
    const settings = { brandName: 'b', brandLine: '', promoText: '', announcementEnabled: true, freeShippingThreshold: 1, shippingFee: 79, lowStockThreshold: 5, returnPolicy: '', seoTitle: '', seoDescription: '', contactEmail: 'a@b.co', contactPhone: '1' };
    await Promise.all([
      api.catalog.listProducts({ q: 'x' }), api.catalog.getProduct('slug'), api.catalog.related('slug'), api.catalog.listCategories(), api.catalog.listCollections(), api.catalog.availability(['v1']), api.catalog.serviceability('560001'),
      api.cart.get(), api.cart.addItem('v1', 1), api.cart.updateItem('l1', 2), api.cart.removeItem('l1'), api.cart.applyCoupon('X'), api.cart.removeCoupon(),
      api.orders.create(input, 'idem-key-12345'), api.orders.get('o1', 't'), api.orders.verifyPayment('p1', {}), api.orders.listMine(),
      api.auth.otpConfig(), api.auth.requestOtp('9876543210'), api.auth.verifyOtp({ requestId: 'r', phone: '9876543210', accessToken: 'x'.repeat(30) }), api.auth.logout(), api.auth.me(),
      api.reviews.list('slug'), api.reviews.create('slug', { rating: 5, title: 't', body: 'long enough', authorName: 'a' }),
      api.content.storefront(), api.content.page('terms'), api.content.subscribeNewsletter('a@b.co'), api.content.submitLead({ name: 'n', email: 'a@b.co', phone: '1234567', type: 't', quantity: 'q', message: '' }),
      api.admin.auth.login('a@b.co', 'x'), api.admin.auth.verifyMfa('123456'), api.admin.auth.logout(), api.admin.auth.me(), api.admin.dashboard(),
      api.admin.products.list(), api.admin.products.create(product), api.admin.products.update('p1', product), api.admin.products.remove('p1'), api.admin.products.bulkFlag('luxe', false),
      api.admin.categories.list(), api.admin.categories.create({ name: 'n', image: '/a', active: true }), api.admin.categories.remove('c1'), api.admin.categories.update('c1', { name: 'n', image: '/a', active: true }),
      api.admin.orders.list(), api.admin.orders.updateStatus('o1', { status: 'shipped' }), api.admin.orders.listReturns(), api.admin.orders.updateReturn('r1', { status: 'approved' }),
      api.orders.cancel('o1', 'changed my mind', 'tok'), api.orders.requestReturn('o1', { reason: 'does not fit', items: [{ orderItemId: 'i1', quantity: 1 }] }, 'tok'), api.admin.reviews.list(), api.admin.reviews.updateStatus('r1', 'hidden'),
      api.admin.leads.list(), api.admin.leads.updateStatus('l1', 'closed'), api.admin.content.get(), api.admin.content.updateSettings(settings),
      api.wishlist.list(), api.wishlist.add('p1'), api.wishlist.remove('p1'), api.auth.addresses.list(), api.auth.addresses.remove('a1'),
      api.auth.addresses.create({ label: 'Home', name: 'Asha', phone: '9876543210', line1: '1 St', city: 'C', state: 'S', pincode: '560001', isDefault: false }),
      api.admin.content.pages(), api.admin.content.savePage('terms', { title: 't', body: 'b', published: true }), api.admin.content.removePage('terms'),
      api.admin.uploads.remove('uploads/2026/10/x.jpg'), api.admin.uploads.cleanup(),
      api.admin.content.updateHeroSlide('h1', { kicker: '', title: '', body: '', desktopImage: '/a', mobileImage: '/a', cta: '', href: '/', active: true }),
    ].map(swallow));

    expect(seen.length).toBeGreaterThan(40);
    const undocumented = seen.filter(request => {
      const pathOnly = request.path.split('?')[0];
      return !operations.some(item => item.method.toUpperCase() === request.method && templateRegex(item.route).test(pathOnly));
    }).map(request => `${request.method} ${request.path}`);
    expect(undocumented).toEqual([]);

    // every documented, frontend-facing operation is reachable through a repository (except probes and the multipart upload, which use their own transport)
    const used = new Set(seen.map(request => `${request.method} ${request.path.split('?')[0]}`));
    const unused = operations.filter(item => {
      if (['/health', '/ready', '/csrf-token', '/admin/uploads'].includes(item.route) && (item.method === 'get' || item.route === '/admin/uploads' && item.method === 'post')) return false; // used by the proxy / browser transport directly
      if (item.route.endsWith('.csv')) return false; // plain download links
      return ![...used].some(key => key.startsWith(`${item.method.toUpperCase()} `) && templateRegex(item.route).test(key.slice(key.indexOf(' ') + 1)));
    }).map(item => item.key);
    expect(unused).toEqual([]);
  });
});
