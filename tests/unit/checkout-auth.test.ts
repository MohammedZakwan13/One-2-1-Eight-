import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvCache } from '@/lib/env';
import { ApiError } from '@/lib/api/errors';
import { loginUrl, safeReturnTo } from '@/lib/return-to';

// ── mocks: the server API (for the page guard), next/navigation, and the database (to PROVE a guest request touches nothing) ──
const me = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const dbSpy = vi.hoisted(() => ({ tables: [] as string[], rpcs: [] as string[], rows: {} as Record<string, unknown> }));
vi.mock('@/lib/api/server', () => ({ serverApi: { auth: { me } } }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/backend/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/backend/core')>();
  const chain = (table: string): unknown => new Proxy(() => undefined, {
    get: (_target, prop) => prop === 'then' ? undefined : prop === 'maybeSingle' || prop === 'single' ? async () => ({ data: dbSpy.rows[table] ?? null, error: null }) : () => chain(table),
  });
  return { ...actual, db: () => ({ from: (table: string) => { dbSpy.tables.push(table); return chain(table); }, rpc: (name: string) => { dbSpy.rpcs.push(name); throw new Error('rpc must not run'); } }) };
});

const { requireCustomerPage } = await import('@/lib/auth/customer-guard');
const { handleBackendRequest } = await import('@/lib/backend/core');
await import('@/lib/backend');

const saved = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { APP_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a' });
  resetServerEnvCache();
  dbSpy.tables = []; dbSpy.rpcs = []; dbSpy.rows = {};
  me.mockReset(); redirectMock.mockClear();
});
afterEach(() => { process.env = { ...saved }; resetServerEnvCache(); });

describe('returnTo is a safe same-site path only', () => {
  it('accepts internal paths and rebuilds them from the parsed URL', () => {
    expect(safeReturnTo('/checkout')).toBe('/checkout');
    expect(safeReturnTo('/products/cotton-shirt?size=M')).toBe('/products/cotton-shirt?size=M');
    expect(safeReturnTo('/account#orders')).toBe('/account');
    expect(loginUrl('/checkout')).toBe('/login?returnTo=%2Fcheckout');
  });
  it.each([
    'https://evil.example/checkout', 'http://evil.example', '//evil.example', '///evil.example', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)',
    'checkout', '', '/\t/evil.example', '/\n/evil.example', '/%0d%0aSet-Cookie:x', ' /checkout', '/checkout\u0000', 'data:text/html,x',
  ])('rejects %j', value => {
    const safe = safeReturnTo(value);
    if (value === '/%0d%0aSet-Cookie:x') expect(safe).toBe('/%0d%0aSet-Cookie:x'); // stays an inert, same-site path (percent-encoded text, no real newline)
    else expect(safe).toBeNull();
    expect(loginUrl(value === '/%0d%0aSet-Cookie:x' ? '' : value)).toBe('/login');
  });
  it('never targets the login page (no redirect loop), the admin console or the API; non-strings and huge values are rejected', () => {
    for (const path of ['/login', '/login?returnTo=%2Fcheckout', '/login/', '/admin', '/admin/orders', '/api/v1/me']) expect(safeReturnTo(path)).toBeNull();
    for (const bad of [undefined, null, 5, {}, ['/checkout'], `/${'a'.repeat(400)}`]) expect(safeReturnTo(bad)).toBeNull();
    expect(loginUrl(null)).toBe('/login');
  });
});

describe('checkout page guard (server side)', () => {
  it('redirects a guest (401 from the session check) to /login?returnTo=%2Fcheckout', async () => {
    me.mockRejectedValue(new ApiError(401, 'unauthorized', 'Please sign in to continue.'));
    await expect(requireCustomerPage('/checkout')).rejects.toThrow('NEXT_REDIRECT:/login?returnTo=%2Fcheckout');
    expect(me).toHaveBeenCalledWith(undefined, { forwardCookies: true });
  });
  it('lets a signed-in customer through, without redirecting', async () => {
    me.mockResolvedValue({ id: 'c1', phone: '9876543210', name: null, email: null });
    await expect(requireCustomerPage('/checkout')).resolves.toBeUndefined();
    expect(redirectMock).not.toHaveBeenCalled();
  });
  it('does not treat an outage as "signed out" or "signed in": other errors propagate without a redirect', async () => {
    me.mockRejectedValue(new ApiError(500, 'server_error', 'Something went wrong.'));
    await expect(requireCustomerPage('/checkout')).rejects.toMatchObject({ status: 500 });
    expect(redirectMock).not.toHaveBeenCalled();
  });
  it('an unsafe destination can only ever produce the plain login URL (no loop, no open redirect)', async () => {
    me.mockRejectedValue(new ApiError(401, 'unauthorized', 'Please sign in to continue.'));
    await expect(requireCustomerPage('https://evil.example')).rejects.toThrow('NEXT_REDIRECT:/login');
    await expect(requireCustomerPage('/login')).rejects.toThrow(/NEXT_REDIRECT:\/login$/);
  });
});

const ORDER_BODY = { contact: { name: 'QA Buyer', phone: '9876543210', email: 'qa@example.com' }, shippingAddress: { line1: '1 Test Road', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' }, paymentMethod: 'cod', acceptedTerms: true };

describe('order creation API requires a signed-in customer (mocked database)', () => {
  const call = (path: string, { session, cart }: { session?: string; cart?: string } = {}) => {
    const cookies = ['o218_csrf=csrf1', ...(session ? [`o218_session=${session}`] : []), ...(cart ? [`o218_cart=${cart}`] : [])].join('; ');
    return handleBackendRequest(new Request(`http://backend.local/api/v1${path}`, {
      method: 'POST', body: JSON.stringify(ORDER_BODY),
      headers: { 'content-type': 'application/json', cookie: cookies, 'x-csrf-token': 'csrf1', 'idempotency-key': 'idem-key-12345' },
    }));
  };
  const CART = '11111111-1111-4111-8111-111111111111';
  const touched = (names: string[]) => names.filter(name => dbSpy.tables.includes(name));

  it('guest POST /orders: 401, and no database access at all (no order, stock, cart, payment or idempotency work)', async () => {
    const response = await call('/orders', { cart: CART });
    expect(response.status).toBe(401);
    expect(dbSpy.tables).toEqual([]);
    expect(dbSpy.rpcs).toEqual([]);
  });
  it('an unknown or expired session cookie is also 401: only the session lookup runs, nothing else', async () => {
    const response = await call('/orders', { session: 'not-a-real-session', cart: CART });
    expect(response.status).toBe(401);
    expect(new Set(dbSpy.tables)).toEqual(new Set(['customer_sessions']));
    expect(dbSpy.rpcs).toEqual([]);
    expect(touched(['orders', 'order_items', 'payments', 'product_variants', 'inventory_movements', 'carts', 'cart_items', 'idempotency_keys'])).toEqual([]);
    dbSpy.tables = [];
    dbSpy.rows.customer_sessions = { expires_at: new Date(Date.now() - 1000).toISOString(), customers: { id: 'c1', phone: '9876543210', name: null, email: null } };
    expect((await call('/orders', { session: 'expired', cart: CART })).status).toBe(401);
    expect(dbSpy.rpcs).toEqual([]);
  });
  it('guest payment confirmation (/payments/:id/verify) is 401 and touches nothing; webhooks keep their own signature check', async () => {
    const response = await call(`/payments/${CART}/verify`);
    expect(response.status).toBe(401);
    expect(dbSpy.tables).toEqual([]);
    expect(dbSpy.rpcs).toEqual([]);
  });
  it('a valid customer session passes the sign-in gate and reaches the normal order checks (empty bag here, so nothing is placed)', async () => {
    dbSpy.rows.customer_sessions = { expires_at: new Date(Date.now() + 60_000).toISOString(), customers: { id: 'c1', phone: '9876543210', name: null, email: null } };
    const response = await call('/orders', { session: 'valid-session' });
    expect(response.status).toBe(409);
    expect(dbSpy.tables[0]).toBe('customer_sessions');
    expect(dbSpy.rpcs).toEqual([]);
  });
});
