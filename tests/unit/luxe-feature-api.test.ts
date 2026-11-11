import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLuxeDb, type FakeLuxeDb } from './helpers/fake-luxe-db';

const h = vi.hoisted(() => ({
  db: null as unknown,
  role: 'owner' as 'owner' | 'support' | null,
  env: { siteUrl: 'https://one21eight.test', apiMode: 'supabase', supabase: { url: 'https://p.supabase.co', serviceRoleKey: 'k', anonKey: 'a' }, adminSessionCookie: 's', razorpay: null, emailProvider: 'resend' },
}));

vi.mock('@/lib/env', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/env')>()), getServerEnv: () => h.env }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.db }));
vi.mock('@/lib/backend/auth', async importOriginal => {
  const { HttpError } = await import('@/lib/backend/core');
  return {
    ...(await importOriginal<typeof import('@/lib/backend/auth')>()),
    requireAdmin: async (_ctx: unknown, area = 'any') => {
      if (!h.role) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.');
      if (area === 'content' && h.role === 'support') throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
      return { id: 'a1', email: 'a@b.co', name: 'A', role: h.role };
    },
  };
});

import { handleBackendRequest } from '@/lib/backend';

const CSRF = 'csrf-token';
const PREFIX = 'https://p.supabase.co/storage/v1/object/public/media/';
const OLD = 'uploads/2026/11/11111111-1111-4111-8111-111111111111.jpg';
const NEW = 'uploads/2026/11/22222222-2222-4222-8222-222222222222.jpg';
const fake = () => h.db as FakeLuxeDb;
const use = (db: FakeLuxeDb) => { h.db = db; delete (globalThis as Record<string, unknown>).__o218_supabase__; };
async function call(method: string, path: string, body?: unknown) {
  const response = await handleBackendRequest(new Request(`https://one21eight.test/api/v1${path}`, {
    method, headers: { 'x-csrf-token': CSRF, cookie: `o218_csrf=${CSRF}; s=session`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const band = (over: Record<string, unknown> = {}) => ({ enabled: true, image: `${PREFIX}${NEW}`, imageAlt: 'Autumn edit', eyebrow: 'NEW SEASON', heading: 'AUTUMN\nEDIT', bodyLine1: 'Line one.', bodyLine2: 'Line two.', ctaLabel: 'SHOP NOW', ctaHref: '/collections/new-arrivals', ...over });
const storedBand = (over: Record<string, unknown> = {}) => ({ enabled: true, image: OLD, imageAlt: 'Old', eyebrow: 'OLD', heading: 'OLD\nHEAD', bodyLine1: 'a', bodyLine2: 'b', ctaLabel: 'GO', ctaHref: '/collections/all', ...over });

beforeEach(() => {
  use(createFakeLuxeDb({ migrated: true }));
  h.role = 'owner';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('reading the section (admin and storefront)', () => {
  it('nothing saved yet: admin sees null (built-in copy) and the storefront gets null, so the homepage keeps its original text', async () => {
    expect((await call('GET', '/admin/content/luxe-feature')).body).toEqual({ luxeFeature: null, available: true });
    const storefront = await call('GET', '/content/storefront');
    expect(storefront.status).toBe(200);
    expect(storefront.body.luxeFeature).toBeNull();
  });
  it('before migration 0011 the admin is told it is unavailable and the public site still works with the built-in copy', async () => {
    use(createFakeLuxeDb({ migrated: false }));
    expect((await call('GET', '/admin/content/luxe-feature')).body).toEqual({ luxeFeature: null, available: false });
    const storefront = await call('GET', '/content/storefront');
    expect(storefront.status).toBe(200);
    expect(storefront.body.luxeFeature).toBeNull();
  });
  it('a corrupt stored value is ignored (built-in copy), never breaking the homepage', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: { heading: '', ctaHref: 'https://evil.example/' } }));
    const storefront = await call('GET', '/content/storefront');
    expect(storefront.status).toBe(200);
    expect(storefront.body.luxeFeature).toBeNull();
  });
  it('requires an admin for both admin routes', async () => {
    h.role = null;
    expect((await call('GET', '/admin/content/luxe-feature')).status).toBe(401);
    expect((await call('PUT', '/admin/content/luxe-feature', band())).status).toBe(401);
    h.role = 'support';
    expect((await call('PUT', '/admin/content/luxe-feature', band())).status).toBe(403);
  });
});

describe('saving persists every field and the homepage data follows', () => {
  it('stores the picture as a Storage path, returns public URLs, survives a reload, and reaches the public API', async () => {
    const saved = await call('PUT', '/admin/content/luxe-feature', band());
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(band());
    expect(fake().settings.luxe_feature).toEqual({ ...band(), image: NEW }); // the database keeps the path, not the URL
    const reload = await call('GET', '/admin/content/luxe-feature');
    expect(reload.body).toEqual({ luxeFeature: band(), available: true }); // "refreshing the admin page retains the saved values"
    const storefront = await call('GET', '/content/storefront');
    expect(storefront.body.luxeFeature).toEqual(band()); // the public homepage reads the latest saved values, no deployment needed
  });
  it('saves the visibility switch and a cleared eyebrow / description', async () => {
    await call('PUT', '/admin/content/luxe-feature', band({ enabled: false, eyebrow: '', bodyLine1: '', bodyLine2: '' }));
    const out = (await call('GET', '/content/storefront')).body.luxeFeature;
    expect(out).toMatchObject({ enabled: false, eyebrow: '', bodyLine1: '', bodyLine2: '' });
  });
  it('an explicit empty picture is saved as empty (the storefront then falls back to the banner still)', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [OLD] }));
    const saved = await call('PUT', '/admin/content/luxe-feature', band({ image: '' }));
    expect(saved.status).toBe(200);
    expect(fake().settings.luxe_feature.image).toBe('');
    expect((await call('GET', '/content/storefront')).body.luxeFeature.image).toBe('');
  });
  it('rejects invalid input without saving anything', async () => {
    for (const bad of [band({ heading: '' }), band({ ctaLabel: '' }), band({ ctaHref: 'https://evil.example/' }), band({ ctaHref: '//evil.example' }), band({ image: 'javascript:alert(1)' }), band({ heading: 'x'.repeat(101) })]) {
      const r = await call('PUT', '/admin/content/luxe-feature', bad);
      expect(r.status).toBe(422);
    }
    expect(fake().writes).toHaveLength(0);
    expect(fake().settings.luxe_feature).toBeNull();
  });
  it('before the migration, saving is refused with a clear 503 and nothing is written', async () => {
    use(createFakeLuxeDb({ migrated: false }));
    const r = await call('PUT', '/admin/content/luxe-feature', band());
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('migration_required');
    expect(r.body.error.message).toContain('0011');
    expect(fake().writes).toHaveLength(0);
  });
  it('repeated saves of the same content are harmless and leave one consistent value', async () => {
    await Promise.all([call('PUT', '/admin/content/luxe-feature', band()), call('PUT', '/admin/content/luxe-feature', band())]);
    expect(fake().settings.luxe_feature).toEqual({ ...band(), image: NEW });
  });
});

describe('storage safety when a picture is replaced or removed', () => {
  it('replacing deletes the OLD file only after the save, and keeps the new one', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [OLD, NEW] }));
    const r = await call('PUT', '/admin/content/luxe-feature', band());
    expect(r.status).toBe(200);
    expect(fake().removed).toEqual([OLD]);
    expect(fake().files.has(NEW)).toBe(true);
    expect(fake().files.has(OLD)).toBe(false);
  });
  it('a failed save keeps the previous record and the old file', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [OLD, NEW], failSettingsUpdate: true }));
    const r = await call('PUT', '/admin/content/luxe-feature', band());
    expect(r.status).toBe(500);
    expect(fake().settings.luxe_feature).toEqual(storedBand());
    expect(fake().removed).toEqual([]);
    expect(fake().files.has(OLD)).toBe(true);
  });
  it.each([
    ['a product', { products: [{ id: 'p', images: [OLD] }] }],
    ['a category', { categories: [{ id: 'c', image: OLD }] }],
    ['a hero banner', { slides: [{ id: 's', desktop_image: OLD, mobile_image: '' }] }],
  ])('a shared old picture (also used by %s) is never deleted', async (_name, extra) => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [OLD, NEW], ...extra }));
    expect((await call('PUT', '/admin/content/luxe-feature', band())).status).toBe(200);
    expect(fake().removed).toEqual([]);
    expect(fake().files.has(OLD)).toBe(true);
  });
  it('removing the picture releases the old file (unshared) and nothing else', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [OLD, 'uploads/2026/11/other.jpg'] }));
    await call('PUT', '/admin/content/luxe-feature', band({ image: '' }));
    expect(fake().removed).toEqual([OLD]);
    expect(fake().files.has('uploads/2026/11/other.jpg')).toBe(true);
  });
  it('the saved picture cannot be deleted through the upload API while the band uses it', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [OLD] }));
    const r = await call('DELETE', `/admin/uploads?path=${encodeURIComponent(OLD)}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('image_in_use');
    expect(fake().files.has(OLD)).toBe(true);
  });
  it('an unused upload is still deletable (the check does not block everything)', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [NEW] }));
    expect((await call('DELETE', `/admin/uploads?path=${encodeURIComponent(NEW)}`)).status).toBe(204);
    expect(fake().files.has(NEW)).toBe(false);
  });
  it('the periodic cleanup of old unreferenced uploads never removes the band picture', async () => {
    use(createFakeLuxeDb({ migrated: true, luxe: storedBand(), storedFiles: [OLD, NEW] }));
    const r = await call('POST', '/admin/uploads/cleanup');
    expect(r.status).toBe(200);
    expect(fake().files.has(OLD)).toBe(true); // used by the band
    expect(fake().files.has(NEW)).toBe(false); // old and unreferenced: removed, which proves the walk really ran
  });
  it('before the migration there is no luxe column, so the checks treat it as "not used" and normal cleanup still works', async () => {
    use(createFakeLuxeDb({ migrated: false, storedFiles: [NEW] }));
    expect((await call('DELETE', `/admin/uploads?path=${encodeURIComponent(NEW)}`)).status).toBe(204);
  });
});
