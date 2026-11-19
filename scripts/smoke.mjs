// End-to-end API smoke test against a RUNNING server and its real Supabase database.
//   npm run smoke                                   → public + security checks only (no data written)
//   SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... npm run smoke
//        → full flow: product + image upload + stock + COD order + concurrency + status + tracking
//   BASE_URL=http://localhost:3001 npm run smoke    → target the Docker container
// The full flow creates clearly named "QA SMOKE" records and removes them afterwards (service-role cleanup).
import { createClient } from '@supabase/supabase-js';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const check = (name, condition, detail) => record(name, Boolean(condition), condition ? '' : detail);

class Client {
  jar = new Map();
  csrf = null;
  async request(method, path, { body, headers = {}, raw } = {}) {
    const mutating = method !== 'GET';
    if (mutating && !this.csrf) this.csrf = (await (await this.request('GET', '/csrf-token')).json()).token;
    const response = await fetch(`${API}${path}`, {
      method, redirect: 'manual',
      headers: { Accept: 'application/json', Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(mutating ? { 'X-CSRF-Token': this.csrf, Origin: BASE } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    for (const line of response.headers.getSetCookie()) { const [pair] = line.split(';'); const i = pair.indexOf('='); this.jar.set(pair.slice(0, i), decodeURIComponent(pair.slice(i + 1))); }
    return response;
  }
  async json(method, path, body, headers) { const response = await this.request(method, path, { body, headers }); return { status: response.status, data: await response.json().catch(() => null) }; }
}

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const anon = new Client();

// ── public endpoints & security gates ──
for (const path of ['/health', '/ready', '/categories', '/collections', '/content/storefront', '/products?pageSize=5', '/serviceability?pincode=560001']) {
  const response = await anon.request('GET', path);
  check(`GET ${path}`, response.status === 200, `status ${response.status}`);
}
check('OpenAPI JSON is served', (await (await fetch(`${API}/openapi.json`)).json()).openapi === '3.1.0');
check('Swagger UI page responds', (await fetch(`${BASE}/docs`)).status === 200);
check('admin API rejects anonymous callers', (await anon.request('GET', '/admin/products')).status === 401);
check('writes without a CSRF token are rejected', (await fetch(`${API}/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
check('invalid lead payload is rejected by the server', (await anon.json('POST', '/leads', { name: 'x' })).status === 422);
check('an unknown product is a clean 404', (await anon.request('GET', '/products/definitely-not-a-product')).status === 404);
check('upload endpoint rejects anonymous callers', (await anon.request('POST', '/admin/uploads', { raw: new FormData() })).status === 401);

const email = process.env.SMOKE_ADMIN_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD;
if (!email || !password) {
  console.log('\n(Set SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD to run the full data flow.)');
} else {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const service = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;
  const admin = new Client();
  const slug = `qa-smoke-${Date.now()}`;
  let productId; let uploadPath; const orderIds = [];
  try {
    const login = await admin.json('POST', '/admin/auth/login', { email, password });
    check('admin login', login.status === 200 && login.data?.admin?.email, `status ${login.status}`);

    // image upload
    const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), 'qa.png');
    const up = await admin.request('POST', '/admin/uploads', { raw: form });
    const upBody = await up.json();
    uploadPath = upBody.path;
    check('image upload to Supabase Storage', up.status === 201 && upBody.url?.includes('/storage/v1/object/public/media/'), `status ${up.status}`);
    check('uploaded image is publicly readable', (await fetch(upBody.url)).status === 200);
    const bad = new FormData(); bad.append('file', new Blob(['<svg onload=alert(1)>'], { type: 'image/png' }), 'x.png');
    check('fake image (SVG named .png) is rejected', (await admin.request('POST', '/admin/uploads', { raw: bad })).status === 422);

    // create product with per-size stock
    const categories = (await (await admin.request('GET', '/admin/categories')).json()).items;
    const input = { name: 'QA SMOKE Tee', slug, categoryId: categories[0].id, price: 499, compareAt: 0, color: 'Black', colorHex: '#000000', badge: null, images: [upBody.url], fit: 'Regular', material: 'Cotton', description: 'QA', bestSeller: false, newArrival: false, luxe: false, status: 'active', stockDisplay: 'exact', variants: [{ size: 'S', stock: 3 }, { size: 'M', stock: 10 }] };
    const created = await admin.json('POST', '/admin/products', input);
    productId = created.data?.id;
    check('create product with per-size stock', created.status === 201 && created.data.variants.length === 2, `status ${created.status}`);
    check('duplicate slug is rejected', (await admin.json('POST', '/admin/products', input)).status === 409);
    const pub = await anon.json('GET', `/products/${slug}`);
    check('storefront shows the product with its uploaded image', pub.status === 200 && pub.data.images[0] === upBody.url);
    check('exact stock mode shows the real quantity', pub.data.variants.find(v => v.size === 'S').availability.quantity === 3);

    // stock update persists
    const updated = await admin.json('PUT', `/admin/products/${productId}`, { ...input, stockDisplay: 'status', variants: [{ size: 'S', stock: 3 }, { size: 'M', stock: 8 }] });
    check('admin stock edit persists', updated.status === 200 && updated.data.variants.find(v => v.size === 'M').stock === 8);
    const hidden = await anon.json('GET', `/products/${slug}`);
    check('status mode hides exact counts from shoppers', hidden.data.variants.every(v => v.availability.quantity === undefined));

    // COD order + stock decrement
    const place = async (client, size, qty = 1, key = crypto.randomUUID()) => {
      const variant = (await (await client.request('GET', `/products/${slug}`)).json()).variants.find(v => v.size === size);
      const add = await client.json('POST', '/cart/items', { variantId: variant.id, quantity: qty });
      if (add.status !== 200) return { status: add.status };
      return { ...(await client.json('POST', '/orders', { contact: { name: 'QA Smoke', phone: '9876543210', email: 'qa-smoke@example.com' }, shippingAddress: { line1: '1 Test Street', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' }, paymentMethod: 'cod', acceptedTerms: true }, { 'Idempotency-Key': key })), key };
    };
    const buyer = new Client();
    const first = await place(buyer, 'M', 2);
    check('COD order is created', first.status === 201 && first.data.order.paymentStatus === 'cod_pending', `status ${first.status}`);
    if (first.data?.order) orderIds.push(first.data.order.id);
    const replay = await buyer.json('POST', '/orders', { contact: { name: 'QA Smoke', phone: '9876543210', email: 'qa-smoke@example.com' }, shippingAddress: { line1: '1 Test Street', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' }, paymentMethod: 'cod', acceptedTerms: true }, { 'Idempotency-Key': first.key });
    check('repeating the same checkout does not create a second order', replay.status === 200 && replay.data.order.id === first.data.order.id, `status ${replay.status}`);
    const afterOrder = await admin.json('GET', '/admin/products');
    check('real stock decreased by the ordered quantity', afterOrder.data.items.find(p => p.id === productId).variants.find(v => v.size === 'M').stock === 6);

    // concurrency: 8 shoppers race for the last 3 units of size S
    const race = await Promise.all(Array.from({ length: 8 }, () => place(new Client(), 'S', 1)));
    const wins = race.filter(r => r.status === 201);
    wins.forEach(r => orderIds.push(r.data.order.id));
    check('concurrent purchases never oversell (exactly 3 of 8 succeed)', wins.length === 3, `${wins.length} succeeded`);
    const dash = await admin.json('GET', '/admin/dashboard/summary');
    check('dashboard low-stock uses the REAL stock (size S is at 0)', dash.data.lowStockItems.some(i => i.name === 'QA SMOKE Tee' && i.size === 'S' && i.stock === 0));

    // status + tracking
    const id = first.data.order.id;
    check('invalid transition is rejected (confirmed → delivered)', (await admin.json('PATCH', `/admin/orders/${id}/status`, { status: 'delivered' })).status === 409);
    for (const status of ['processing', 'packed']) check(`order → ${status}`, (await admin.json('PATCH', `/admin/orders/${id}/status`, { status })).status === 200);
    const shipped = await admin.json('PATCH', `/admin/orders/${id}/status`, { status: 'shipped', carrier: 'QA Courier', trackingNumber: 'QA123' });
    check('order → shipped with tracking; payment stays unpaid-COD', shipped.status === 200 && shipped.data.paymentStatus === 'cod_pending' && shipped.data.shipment?.trackingNumber === 'QA123');
    const track = await buyer.json('GET', `/orders/${id}?token=${first.data.lookupToken}`);
    check('customer tracking shows the admin update and history', track.status === 200 && track.data.status === 'shipped' && track.data.history.length >= 4);
    check('order is not readable without the token', (await new Client().json('GET', `/orders/${id}`)).status === 404);
    check('order is not readable with a wrong token', (await new Client().json('GET', `/orders/${id}?token=${'0'.repeat(48)}`)).status === 404);

    // cancel restores stock
    const cancelId = wins[0].data.order.id;
    check('cancelling an order succeeds', (await admin.json('PATCH', `/admin/orders/${cancelId}/status`, { status: 'cancelled' })).status === 200);
    const restored = await admin.json('GET', '/admin/products');
    check('cancellation restores stock exactly once', restored.data.items.find(p => p.id === productId).variants.find(v => v.size === 'S').stock === 1);
    await admin.json('PATCH', `/admin/orders/${cancelId}/status`, { status: 'cancelled' });
    check('cancelling twice does not double-restore', (await admin.json('GET', '/admin/products')).data.items.find(p => p.id === productId).variants.find(v => v.size === 'S').stock === 1);

    // lead capture
    const lead = { name: 'QA Smoke', email: 'qa-smoke@example.com', phone: '9876543210', type: 'QA smoke', quantity: '10', message: `smoke ${slug}` };
    const l1 = await anon.json('POST', '/leads', lead); const l2 = await anon.json('POST', '/leads', lead);
    check('lead saved and duplicate submission is idempotent', l1.status === 201 && l2.status === 200 && l1.data.id === l2.data.id, `${l1.status}/${l2.status}`);
    check('admin can see the lead', (await admin.json('GET', '/admin/leads')).data.items.some(item => item.id === l1.data.id));
    if (service) await service.from('leads').delete().eq('id', l1.data.id);
  } catch (error) {
    record('smoke run completed without exceptions', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (service) {
      for (const id of orderIds) await service.from('orders').delete().eq('id', id);
      if (productId) await service.from('products').delete().eq('id', productId);
      if (uploadPath) await service.storage.from('media').remove([uploadPath]);
      await service.from('email_log').delete().like('to_email', 'qa-smoke@%');
    } else if (productId) console.log('No service key set: QA SMOKE records were left in place (set the product to draft in the admin).');
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
