import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHeroDb, type FakeHeroDb } from './helpers/fake-hero-db';
import { mp4, webm } from './helpers/media-fixtures';
import { createUploadSession } from '@/lib/upload-session';

const h = vi.hoisted(() => ({
  db: null as unknown,
  role: 'owner' as 'owner' | 'support' | null,
  env: { siteUrl: 'https://one21eight.test', apiMode: 'supabase', supabase: { url: 'https://p.supabase.co', serviceRoleKey: 'k', anonKey: 'a' }, adminSessionCookie: 's', razorpay: null, emailProvider: 'resend', resend: null, mailpit: null } as Record<string, unknown>,
}));

vi.mock('@/lib/env', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/env')>()), getServerEnv: () => h.env }));
// The real core.db() builds its client with createClient; handing it the in-memory fake keeps core's own storage helpers on the same data.
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
import { heroDto } from '@/lib/backend/routes/storefront';
import { HERO_VIDEO_MAX_BYTES } from '@/lib/hero-media';

type Slide = { id: string; title: string; active: boolean; sortOrder: number; updatedAt: string; [key: string]: unknown };
const CSRF = 'csrf-token';
const fake = () => h.db as FakeHeroDb;
const headers = () => ({ 'x-csrf-token': CSRF, cookie: `o218_csrf=${CSRF}; s=session` });
async function call(method: string, path: string, body?: unknown) {
  const response = await handleBackendRequest(new Request(`https://one21eight.test/api/v1${path}`, { method, headers: { ...headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function upload(path: string, bytes: Uint8Array, name: string, type: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], name, { type }));
  const response = await handleBackendRequest(new Request(`https://one21eight.test/api/v1${path}`, { method: 'POST', headers: { ...headers(), ...extra }, body: form }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const MP4 = mp4();
const HEVC_MP4 = mp4({ video: 'hvc1' });
const WEBM = webm();
const MKV = webm({ docType: 'matroska' });
const media = (path: string) => `https://p.supabase.co/storage/v1/object/public/media/${path}`;
const banner = (over: Record<string, unknown> = {}) => ({ kicker: '', title: 'Banner', body: 'Copy', cta: '', href: '/collections/all', active: false, desktopImage: '/images/a.webp', mobileImage: '/images/b.webp', ...over });
const create = async (over: Record<string, unknown> = {}) => { const r = await call('POST', '/admin/content/hero-slides', banner(over)); expect(r.status).toBe(201); return r.body as Slide; };
const listAdmin = async () => ((await call('GET', '/admin/content')).body.heroSlides as Slide[]);
const listStore = async () => ((await call('GET', '/content/storefront')).body.heroSlides as Slide[]);

const useDb = (db: FakeHeroDb) => { h.db = db; delete (globalThis as Record<string, unknown>).__o218_supabase__; };

beforeEach(() => {
  useDb(createFakeHeroDb());
  h.role = 'owner';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-08T00:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 })); // the public-URL readability probe
});
afterEach(() => { vi.useRealTimers(); });
const later = (seconds = 5) => vi.setSystemTime(Date.now() + seconds * 1000);

describe('creating, editing and deleting banners', () => {
  it('creates a banner (a hidden draft by default in the UI), appended to the end of the carousel', async () => {
    const first = await create({ title: 'One' });
    const second = await create({ title: 'Two' });
    expect(first).toMatchObject({ title: 'One', active: false, desktopMediaType: 'image', mobileMediaType: 'image', useDesktopOnMobile: false, sortOrder: 1 });
    expect(second.sortOrder).toBe(2);
    expect((await listAdmin()).map(s => s.title)).toEqual(['One', 'Two']);
  });

  it('edits a banner and keeps the fields that were not touched', async () => {
    const created = await create({ title: 'Old', body: 'Keep me', href: '/collections/layering-edit' });
    later();
    const edited = await call('PUT', `/admin/content/hero-slides/${created.id}`, banner({ title: 'New', body: 'Keep me', href: '/collections/layering-edit', altText: 'A model in a jacket', expectedUpdatedAt: created.updatedAt }));
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id: created.id, title: 'New', body: 'Keep me', href: '/collections/layering-edit', altText: 'A model in a jacket', sortOrder: 1 });
  });

  it('refuses a stale edit instead of overwriting another admin (409), and accepts the next fresh one', async () => {
    const created = await create({ title: 'Shared' });
    later();
    const mine = await call('PUT', `/admin/content/hero-slides/${created.id}`, banner({ title: 'Mine', expectedUpdatedAt: created.updatedAt }));
    expect(mine.status).toBe(200);
    later();
    const theirs = await call('PUT', `/admin/content/hero-slides/${created.id}`, banner({ title: 'Theirs', expectedUpdatedAt: created.updatedAt }));
    expect(theirs.status).toBe(409);
    expect(theirs.body.error.code).toBe('slide_changed');
    expect((await listAdmin())[0].title).toBe('Mine');
    later();
    expect((await call('PUT', `/admin/content/hero-slides/${created.id}`, banner({ title: 'Theirs, redone', expectedUpdatedAt: mine.body.updatedAt }))).status).toBe(200);
  });

  it('deletes a banner and its files, but never a file another banner still uses', async () => {
    const a = await create({ desktopImage: media('uploads/2026/11/a.webp'), mobileImage: media('uploads/2026/11/b.webp') });
    const b = (await call('POST', `/admin/content/hero-slides/${a.id}/duplicate`)).body as Slide; // shares both files
    expect((await call('DELETE', `/admin/content/hero-slides/${a.id}`)).status).toBe(204);
    expect(fake().removed).toEqual([]); // the copy still points at them
    expect((await call('DELETE', `/admin/content/hero-slides/${b.id}`)).status).toBe(204);
    expect(fake().removed.flatMap(entry => entry.paths).sort()).toEqual(['uploads/2026/11/a.webp', 'uploads/2026/11/b.webp']);
    expect(await listAdmin()).toEqual([]);
    expect((await call('DELETE', `/admin/content/hero-slides/${a.id}`)).status).toBe(404);
  });

  it('a malformed id is a 404, never a database error', async () => {
    expect((await call('DELETE', '/admin/content/hero-slides/not-a-uuid')).status).toBe(404);
    expect((await call('POST', '/admin/content/hero-slides/not-a-uuid/duplicate')).status).toBe(404);
  });
});

describe('duplicating, activating and ordering', () => {
  it('duplicates as a hidden draft placed right after the original, sharing its media', async () => {
    const a = await create({ title: 'A', active: true });
    await create({ title: 'B', active: true });
    const copy = (await call('POST', `/admin/content/hero-slides/${a.id}/duplicate`)).body as Slide;
    expect(copy).toMatchObject({ title: 'A', active: false, desktopImage: '/images/a.webp', mobileImage: '/images/b.webp' });
    expect(copy.id).not.toBe(a.id);
    expect((await listAdmin()).map(s => `${s.title}:${s.active}`)).toEqual(['A:true', 'A:false', 'B:true']);
  });

  it('hides and shows a banner without touching anything else; a live banner must have media', async () => {
    const a = await create({ title: 'A', active: true });
    later();
    const hidden = await call('PUT', `/admin/content/hero-slides/${a.id}`, banner({ title: 'A', active: false, expectedUpdatedAt: a.updatedAt }));
    expect(hidden.body.active).toBe(false);
    expect(await listStore()).toEqual([]);
    later();
    const empty = await call('PUT', `/admin/content/hero-slides/${a.id}`, banner({ title: 'A', active: true, desktopImage: '', expectedUpdatedAt: hidden.body.updatedAt }));
    expect(empty.status).toBe(422);
    expect(JSON.stringify(empty.body)).toContain('desktopImage');
    later();
    expect((await call('PUT', `/admin/content/hero-slides/${a.id}`, banner({ title: 'A', active: true, expectedUpdatedAt: hidden.body.updatedAt }))).status).toBe(200);
    expect((await listStore()).map(s => s.title)).toEqual(['A']);
  });

  it('a draft can be saved without media (it is never public)', async () => {
    const draft = await call('POST', '/admin/content/hero-slides', banner({ active: false, desktopImage: '', mobileImage: '' }));
    expect(draft.status).toBe(201);
    expect(await listStore()).toEqual([]);
  });

  it('reorders atomically and the order survives a refresh, on the admin list and the storefront', async () => {
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C', 'D']) ids.push((await create({ title, active: true })).id);
    const next = [ids[3], ids[0], ids[2], ids[1]];
    const saved = await call('PUT', '/admin/content/hero-slides/order', { ids: next });
    expect(saved.status).toBe(200);
    expect(saved.body.items.map((s: { id: string }) => s.id)).toEqual(next);
    expect((await listAdmin()).map(s => s.id)).toEqual(next);
    expect((await listStore()).map(s => s.id)).toEqual(next);
    expect((await listStore()).map(s => s.sortOrder)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a stale, incomplete or repeated order list (409) and malformed input (422), changing nothing', async () => {
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C']) ids.push((await create({ title })).id);
    const before = (await listAdmin()).map(s => s.id);
    for (const bad of [[ids[0], ids[1]], [ids[0], ids[0], ids[1]], [...ids, ids[0]]]) {
      const r = await call('PUT', '/admin/content/hero-slides/order', { ids: bad });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('order_changed');
    }
    expect((await call('PUT', '/admin/content/hero-slides/order', { ids: ['x'] })).status).toBe(422);
    expect((await call('PUT', '/admin/content/hero-slides/order', { ids: [] })).status).toBe(422);
    expect((await listAdmin()).map(s => s.id)).toEqual(before);
  });

  it('has no banner-count limit: 14 banners can be created, reordered and published', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 14; i += 1) ids.push((await create({ title: `Banner ${i}`, active: true })).id);
    expect(await listAdmin()).toHaveLength(14);
    expect((await listStore())).toHaveLength(14);
    const reversed = [...ids].reverse();
    expect((await call('PUT', '/admin/content/hero-slides/order', { ids: reversed })).status).toBe(200);
    expect((await listStore()).map(s => s.id)).toEqual(reversed);
    expect((await listStore()).map(s => s.sortOrder)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('the source has no hard-coded banner cap', () => {
    for (const file of ['lib/backend/routes/hero-banners.ts', 'components/admin/hero-banners.tsx', 'supabase/migrations/0010_hero_banner_media.sql']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/slides?\.length\s*>=?\s*\d|\.limit\((4|9)\)|check\s*\(\s*sort_order\s*<=/i);
    }
  });
});

describe('independent desktop and mobile media', () => {
  it('stores desktop and mobile media separately: changing one never touches the other', async () => {
    const created = await create({ active: true, desktopImage: media('uploads/2026/11/d1.webp'), mobileImage: media('uploads/2026/11/m1.webp') });
    later();
    const edited = await call('PUT', `/admin/content/hero-slides/${created.id}`, banner({ active: true, desktopImage: media('uploads/2026/11/d2.webp'), mobileImage: media('uploads/2026/11/m1.webp'), expectedUpdatedAt: created.updatedAt }));
    expect(edited.body).toMatchObject({ desktopImage: 'https://p.supabase.co/storage/v1/object/public/media/uploads/2026/11/d2.webp', mobileImage: 'https://p.supabase.co/storage/v1/object/public/media/uploads/2026/11/m1.webp' });
    expect(fake().removed).toEqual([{ bucket: 'media', paths: ['uploads/2026/11/d1.webp'] }]); // only the replaced desktop file
  });

  it('desktop video + mobile image, and mobile video + desktop image, are both valid and kept apart', async () => {
    const dv = 'https://p.supabase.co/storage/v1/object/public/banner-media/banners/2026/11/11111111-1111-1111-1111-111111111111.mp4';
    const mv = 'https://p.supabase.co/storage/v1/object/public/banner-media/banners/2026/11/22222222-2222-2222-2222-222222222222.webm';
    const a = await create({ active: true, desktopMediaType: 'video', desktopVideo: dv, desktopImage: '/images/poster.webp', mobileMediaType: 'image', mobileImage: '/images/m.webp' });
    expect(a).toMatchObject({ desktopMediaType: 'video', desktopVideo: dv, mobileMediaType: 'image', mobileVideo: '' });
    const b = await create({ active: true, desktopMediaType: 'image', mobileMediaType: 'video', mobileVideo: mv, mobileImage: '' });
    expect(b).toMatchObject({ desktopMediaType: 'image', mobileMediaType: 'video', mobileVideo: mv, mobileImage: '' });
    // the database holds the storage PATH, the API returns the public URL
    expect(fake().slides.find(row => row.id === a.id)!.desktop_video).toBe('banners/2026/11/11111111-1111-1111-1111-111111111111.mp4');
  });

  it('video is optional: a live banner needs an image OR a video per device; "use desktop media on mobile" makes the mobile slot optional', async () => {
    const noVideo = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopMediaType: 'video', desktopVideo: '' }));
    expect(noVideo.status).toBe(201); // its image is the banner image
    expect(noVideo.body.desktopMediaType).toBe('image');
    const noMedia = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopMediaType: 'video', desktopVideo: '', desktopImage: '' }));
    expect(noMedia.status).toBe(422);
    expect(JSON.stringify(noMedia.body)).toContain('Add a desktop image or video before publishing.');
    const noMobile = await call('POST', '/admin/content/hero-slides', banner({ active: true, mobileImage: '' }));
    expect(noMobile.status).toBe(422);
    expect(JSON.stringify(noMobile.body)).toContain('Add a mobile image or video before publishing.');
    const shared = await call('POST', '/admin/content/hero-slides', banner({ active: true, mobileImage: '', useDesktopOnMobile: true }));
    expect(shared.status).toBe(201);
    expect(shared.body.useDesktopOnMobile).toBe(true);
  });

  it('replacing or removing a video deletes the old file from the video bucket only when nothing else uses it', async () => {
    const path = (n: number) => `banners/2026/11/${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}.mp4`;
    const url = (n: number) => `https://p.supabase.co/storage/v1/object/public/banner-media/${path(n)}`;
    const a = await create({ active: true, desktopMediaType: 'video', desktopVideo: url(1), desktopImage: '/images/p.webp' });
    later();
    const replaced = await call('PUT', `/admin/content/hero-slides/${a.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: url(2), desktopImage: '/images/p.webp', expectedUpdatedAt: a.updatedAt }));
    expect(fake().removed).toEqual([{ bucket: 'banner-media', paths: [path(1)] }]);
    later();
    await call('PUT', `/admin/content/hero-slides/${a.id}`, banner({ active: true, desktopMediaType: 'image', desktopVideo: '', expectedUpdatedAt: replaced.body.updatedAt }));
    expect(fake().removed.at(-1)).toEqual({ bucket: 'banner-media', paths: [path(2)] });
  });
});

describe('image uploads (existing endpoint, used for desktop, mobile and poster images)', () => {
  it('accepts a real image for either device and returns its storage path and URL', async () => {
    for (const name of ['desktop.png', 'mobile.png']) {
      const r = await upload('/admin/uploads', PNG, name, 'image/png');
      expect(r.status).toBe(201);
      expect(String(r.body.path)).toMatch(/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    }
  });
  it('rejects a GIF, an image claiming to be another type, and an image over 10 MB', async () => {
    expect((await upload('/admin/uploads', GIF, 'a.gif', 'image/gif')).status).toBe(422);
    expect((await upload('/admin/uploads', GIF, 'a.png', 'image/png')).status).toBe(422);
    const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(PNG);
    expect((await upload('/admin/uploads', big, 'big.png', 'image/png')).status).toBe(413);
  });
});

describe('video uploads', () => {
  it('accepts MP4 (H.264) and WebM, stores them in the video bucket and returns the public URL', async () => {
    const mp4 = await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4');
    expect(mp4.status).toBe(201);
    expect(String(mp4.body.path)).toMatch(/^banners\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.mp4$/);
    expect(mp4.body.url).toBe(`https://p.supabase.co/storage/v1/object/public/banner-media/${mp4.body.path}`);
    const webm = await upload('/admin/uploads/banner-video', WEBM, 'a.webm', 'video/webm');
    expect(webm.status).toBe(201);
    expect(String(webm.body.path)).toMatch(/\.webm$/);
    expect([...fake().storage['banner-media'].keys()]).toHaveLength(2);
    expect(fake().storage.media.size).toBe(0);
  });
  it('rejects by the file bytes, not the name or declared type: MKV, HEVC, a renamed image, an empty file', async () => {
    expect((await upload('/admin/uploads/banner-video', MKV, 'a.webm', 'video/webm')).status).toBe(422);
    const hevc = await upload('/admin/uploads/banner-video', HEVC_MP4, 'iphone.mp4', 'video/mp4');
    expect(hevc.status).toBe(422);
    expect((hevc.body.error as { code: string }).code).toBe('unsupported_codec');
    expect((await upload('/admin/uploads/banner-video', PNG, 'fake.mp4', 'video/mp4')).status).toBe(422);
    expect((await upload('/admin/uploads/banner-video', new Uint8Array(0), 'empty.mp4', 'video/mp4')).status).toBe(422);
    expect(fake().storage['banner-media'].size).toBe(0);
  });
  it('enforces the size cap from the real file size and from the declared length', async () => {
    const big = new Uint8Array(HERO_VIDEO_MAX_BYTES + 1); big.set(MP4);
    expect((await upload('/admin/uploads/banner-video', big, 'big.mp4', 'video/mp4')).status).toBe(413);
    const declared = await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4', { 'content-length': String(HERO_VIDEO_MAX_BYTES + 1024 * 1024) });
    expect(declared.status).toBe(413);
    const exactly = new Uint8Array(HERO_VIDEO_MAX_BYTES); exactly.set(MP4);
    expect((await upload('/admin/uploads/banner-video', exactly, 'edge.mp4', 'video/mp4')).status).toBe(201);
  });
  it('flags an MP4 whose index is at the end of the file (slow start) without rejecting it', async () => {
    const slow = await upload('/admin/uploads/banner-video', mp4({ moovFirst: false }), 'slow.mp4', 'video/mp4');
    expect(slow.status).toBe(201);
    expect((slow.body.warnings as string[]).join(' ')).toMatch(/fast ?start/i);
    expect((await upload('/admin/uploads/banner-video', MP4, 'ok.mp4', 'video/mp4')).body.warnings).toEqual([]);
  });
  it('deletes an unsaved upload, but refuses to delete a video a banner uses', async () => {
    const up = await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4');
    const path = String(up.body.path);
    await create({ active: true, desktopMediaType: 'video', desktopVideo: String(up.body.url), desktopImage: '/images/p.webp' });
    expect((await call('DELETE', `/admin/uploads/banner-video?path=${encodeURIComponent(path)}`)).status).toBe(409);
    const unsaved = await upload('/admin/uploads/banner-video', WEBM, 'b.webm', 'video/webm');
    expect((await call('DELETE', `/admin/uploads/banner-video?path=${encodeURIComponent(String(unsaved.body.path))}`)).status).toBe(204);
    expect((await call('DELETE', '/admin/uploads/banner-video?path=../../etc/passwd')).status).toBe(422);
  });
});

describe('video upload failures are explained, never generic, and never harm the existing video', () => {
  const QT_HEVC = mp4({ brand: 'qt  ', video: 'hvc1' });
  const QT_H264 = mp4({ brand: 'qt  ', video: 'avc1' });
  const savedVideo = async () => {
    const up = await upload('/admin/uploads/banner-video', MP4, 'good.mp4', 'video/mp4');
    const saved = await create({ active: true, desktopMediaType: 'video', desktopVideo: String(up.body.url), desktopImage: '/images/p.webp' });
    return { path: String(up.body.path), saved };
  };
  const errorOf = (r: { body: Record<string, unknown> }) => r.body.error as { code: string; message: string };

  it('a QuickTime (.mov) file named .MP4 is refused as a container, with the reason and how to fix it (HEVC iPhone files get their own explanation)', async () => {
    const hevc = await upload('/admin/uploads/banner-video', QT_HEVC, 'iphone-clip.MP4', 'video/mp4');
    expect(hevc.status).toBe(422);
    expect(errorOf(hevc).code).toBe('unsupported_container');
    expect(errorOf(hevc).message).toMatch(/QuickTime[\s\S]*HEVC[\s\S]*named \.MP4[\s\S]*ffmpeg/);
    const h264 = await upload('/admin/uploads/banner-video', QT_H264, 'clip.mp4', 'video/mp4');
    expect(h264.status).toBe(422);
    expect(errorOf(h264).code).toBe('unsupported_container');
    expect(errorOf(h264).message).toMatch(/QuickTime/);
    expect(errorOf(h264).message).not.toMatch(/HEVC/);
    expect(fake().storage['banner-media'].size).toBe(0);
  });

  it('keeps the refusals apart: container, codec, not-a-video and size', async () => {
    const code = async (bytes: Uint8Array) => errorOf(await upload('/admin/uploads/banner-video', bytes, 'x.mp4', 'video/mp4')).code;
    expect(await code(QT_HEVC)).toBe('unsupported_container');
    expect(await code(MKV)).toBe('unsupported_container');
    expect(await code(HEVC_MP4)).toBe('unsupported_codec');
    expect(await code(PNG)).toBe('invalid_video');
    const big = new Uint8Array(HERO_VIDEO_MAX_BYTES + 1); big.set(MP4);
    expect(await code(big)).toBe('file_too_large');
  });

  it.each([
    ['the bucket does not exist', { message: 'Bucket not found', statusCode: '404' }, 503, 'migration_required', /bucket "banner-media" does not exist/],
    ['the bucket does not exist (older wording)', { message: 'The related resource does not exist', status: 404 }, 503, 'migration_required', /migration 0010/],
    ['Supabase refuses the size', { message: 'The object exceeded the maximum allowed size', statusCode: '413' }, 413, 'file_too_large', /global upload limit/],
    ['the bucket refuses the file type', { message: 'mime type video/mp4 is not supported', statusCode: '415' }, 422, 'unsupported_type', /video\/mp4 and video\/webm/],
    ['the server credentials are rejected', { message: 'Invalid JWT', statusCode: '403' }, 502, 'storage_unauthorized', /SUPABASE_SERVICE_ROLE_KEY/],
    ['Supabase cannot be reached', { message: 'fetch failed', name: 'StorageUnknownError' }, 503, 'storage_unreachable', /network or DNS/],
    ['anything else shows what Storage actually said', { message: 'Internal server error while writing', statusCode: '500' }, 502, 'upload_failed', /Storage said: “Internal server error while writing” \(HTTP 500\)/],
  ])('Storage failure: %s', async (_name, failure, status, code, message) => {
    fake().uploadFailure = failure;
    const r = await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4');
    expect(r.status).toBe(status);
    expect(errorOf(r).code).toBe(code);
    expect(errorOf(r).message).toMatch(message);
  });

  it('never prints a token or key that appears in a Storage error', async () => {
    // Fake secrets, assembled at run time so no secret-shaped text is stored in the repository.
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZSJ9', 'c2lnbmF0dXJl'].join('.');
    const fakeKey = ['sk', 'live', 'abcdefghijkl'].join('_');
    fake().uploadFailure = { message: `bad header ${fakeJwt} and ${fakeKey}`, statusCode: '500' };
    const r = await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4');
    const text = JSON.stringify(r.body) + JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(text).not.toContain(fakeJwt.slice(0, 12));
    expect(text).not.toContain(fakeKey);
  });

  it('a failed replacement upload leaves the banner and its existing video exactly as they were', async () => {
    const { path, saved } = await savedVideo();
    fake().uploadFailure = { message: 'fetch failed' };
    const before = JSON.stringify(fake().slides);
    expect((await upload('/admin/uploads/banner-video', WEBM, 'new.webm', 'video/webm')).status).toBe(503);
    expect(JSON.stringify(fake().slides)).toBe(before);
    expect(fake().storage['banner-media'].has(path)).toBe(true);
    expect(fake().removed).toEqual([]);
    expect((await listAdmin())[0]).toMatchObject({ id: saved.id, desktopMediaType: 'video' });
  });

  it('a successful replacement gets a brand-new path; the old file is only deleted when the banner is saved', async () => {
    const { path, saved } = await savedVideo();
    const fresh = await upload('/admin/uploads/banner-video', WEBM, 'new.webm', 'video/webm');
    expect(String(fresh.body.path)).not.toBe(path);
    expect(fake().storage['banner-media'].has(path)).toBe(true);
    later();
    await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: String(fresh.body.url), desktopImage: '/images/p.webp', expectedUpdatedAt: saved.updatedAt }));
    expect(fake().storage['banner-media'].has(path)).toBe(false);
    expect(fake().storage['banner-media'].has(String(fresh.body.path))).toBe(true);
  });

  it('desktop and mobile videos upload independently and are saved side by side', async () => {
    const d = await upload('/admin/uploads/banner-video', MP4, 'desktop.mp4', 'video/mp4');
    const m = await upload('/admin/uploads/banner-video', WEBM, 'mobile.webm', 'video/webm');
    expect(d.body.path).not.toBe(m.body.path);
    const created = await create({ active: true, desktopMediaType: 'video', desktopVideo: String(d.body.url), desktopImage: '/images/d-poster.webp', mobileMediaType: 'video', mobileVideo: String(m.body.url), mobileImage: '/images/m-poster.webp' });
    expect(created).toMatchObject({ desktopVideo: d.body.url, mobileVideo: m.body.url, desktopImage: '/images/d-poster.webp', mobileImage: '/images/m-poster.webp' });
    later();
    const swapped = await upload('/admin/uploads/banner-video', MP4, 'mobile2.mp4', 'video/mp4');
    const edited = await call('PUT', `/admin/content/hero-slides/${created.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: String(d.body.url), desktopImage: '/images/d-poster.webp', mobileMediaType: 'video', mobileVideo: String(swapped.body.url), mobileImage: '/images/m-poster.webp', expectedUpdatedAt: created.updatedAt }));
    expect(edited.body.desktopVideo).toBe(d.body.url);
    expect(fake().storage['banner-media'].has(String(d.body.path))).toBe(true);
    expect(fake().storage['banner-media'].has(String(m.body.path))).toBe(false); // only the replaced mobile file went
  });

  it('refuses and undoes an upload whose public URL visitors cannot read (private bucket)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 403 }));
    const r = await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4');
    expect(r.status).toBe(502);
    expect(errorOf(r).code).toBe('storage_unreadable');
    expect(fake().storage['banner-media'].size).toBe(0);
  });

  it('a network blip while checking the public URL does not undo a good upload', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network'));
    expect((await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4')).status).toBe(201);
    expect(fake().storage['banner-media'].size).toBe(1);
  });

  it('the 12 MB limit is one value everywhere: browser, server, bucket and the text shown to the admin', () => {
    expect(HERO_VIDEO_MAX_BYTES).toBe(12 * 1024 * 1024);
    expect(readFileSync('supabase/migrations/0010_hero_banner_media.sql', 'utf8')).toContain(String(HERO_VIDEO_MAX_BYTES));
    expect(readFileSync('lib/backend/routes/hero-banners.ts', 'utf8')).toContain('HERO_VIDEO_MAX_BYTES');
    expect(readFileSync('components/admin/hero-video-uploader.tsx', 'utf8')).toContain('HERO_VIDEO_MAX_LABEL');
    expect(readFileSync('lib/hero-media.ts', 'utf8')).toContain("HERO_VIDEO_MAX_LABEL = '12 MB'");
  });

  it('the uploader checks the file contents in the browser before uploading, and registers each upload with the editor session', () => {
    const source = readFileSync('components/admin/hero-video-uploader.tsx', 'utf8');
    expect(source).toContain('inspectHeroVideo(new Uint8Array(await file.arrayBuffer()))');
    expect(source).toContain('removeBannerVideo');
    expect(source).toContain('session?.track(');
  });
});

describe('editor upload lifecycle: what the banner editor does, against the real routes', () => {
  const videoRemover = (path: string) => () => call('DELETE', `/admin/uploads/banner-video?path=${encodeURIComponent(path)}`);
  const imageRemover = (path: string) => () => call('DELETE', `/admin/uploads?path=${encodeURIComponent(path)}`);
  const uploadVideo = async (session: ReturnType<typeof createUploadSession>, bytes = MP4, name = 'v.mp4', type = 'video/mp4') => {
    const r = await upload('/admin/uploads/banner-video', bytes, name, type);
    expect(r.status).toBe(201);
    session.track(String(r.body.url), videoRemover(String(r.body.path)));
    return { url: String(r.body.url), path: String(r.body.path) };
  };
  const uploadImage = async (session: ReturnType<typeof createUploadSession>) => {
    const r = await upload('/admin/uploads', PNG, 'p.png', 'image/png');
    expect(r.status).toBe(201);
    session.track(String(r.body.url), imageRemover(String(r.body.path)));
    return { url: String(r.body.url), path: String(r.body.path) };
  };
  /** A banner that already exists with a saved video and a saved poster, exactly as an admin would have left it. */
  const existing = async () => {
    const setup = createUploadSession();
    const video = await uploadVideo(setup);
    const poster = await uploadImage(setup);
    const saved = await create({ active: true, desktopMediaType: 'video', desktopVideo: video.url, desktopImage: poster.url, mobileImage: '/images/m.webp' });
    await setup.commit([video.url, poster.url]);
    return { saved, video, poster };
  };

  it('a failed save keeps the existing banner and its media, and deleting the new uploads on close leaves no orphans', async () => {
    const { saved, video, poster } = await existing();
    const session = createUploadSession();
    const newVideo = await uploadVideo(session, WEBM, 'new.webm', 'video/webm');
    const newPoster = await uploadImage(session);
    later();
    // someone else saved first, so this save is refused
    await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: video.url, desktopImage: poster.url, title: 'Theirs', expectedUpdatedAt: saved.updatedAt }));
    later();
    const mine = await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: newVideo.url, desktopImage: newPoster.url, expectedUpdatedAt: saved.updatedAt }));
    expect(mine.status).toBe(409);
    const before = JSON.stringify(fake().slides);
    await session.abandon(); // the editor is closed after the failed save
    expect(JSON.stringify(fake().slides)).toBe(before);
    expect([...fake().storage['banner-media'].keys()]).toEqual([video.path]);
    expect([...fake().storage.media.keys()]).toEqual([poster.path]);
  });

  it('repeated replacement uploads leave exactly one stored file, whether or not each replaced one is deleted on the spot', async () => {
    // (a) like the uploader: every replacement deletes the previous unsaved upload at once
    const a = createUploadSession();
    const v1 = await uploadVideo(a);
    const v2 = await uploadVideo(a, WEBM, 'b.webm', 'video/webm');
    await videoRemover(v1.path)(); a.forget(v1.url);
    const v3 = await uploadVideo(a);
    await videoRemover(v2.path)(); a.forget(v2.url);
    expect(a.size).toBe(1);
    const saved = await create({ active: true, desktopMediaType: 'video', desktopVideo: v3.url, desktopImage: '/images/p.webp' });
    await a.commit([v3.url]);
    expect([...fake().storage['banner-media'].keys()]).toEqual([v3.path]);
    expect((await listAdmin())[0]).toMatchObject({ id: saved.id, desktopVideo: v3.url });

    // (b) if some replacement was never cleaned up one by one, saving still removes everything the saved banner does not use
    const b = createUploadSession();
    const w1 = await uploadVideo(b); const w2 = await uploadVideo(b); const w3 = await uploadVideo(b);
    later();
    await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: w3.url, desktopImage: '/images/p.webp', expectedUpdatedAt: saved.updatedAt }));
    await b.commit([w3.url]);
    const left = [...fake().storage['banner-media'].keys()];
    expect(left).toEqual([w3.path]);
    expect(left).not.toContain(w1.path); expect(left).not.toContain(w2.path); expect(left).not.toContain(v3.path);
  });

  it('a file the saved banner does not use is deleted on commit, e.g. a mobile video the admin uploaded and then did not keep', async () => {
    const session = createUploadSession();
    const used = await uploadVideo(session);
    const unused = await uploadVideo(session, WEBM, 'm.webm', 'video/webm');
    await create({ active: true, desktopMediaType: 'video', desktopVideo: used.url, desktopImage: '/images/p.webp' });
    await session.commit([used.url]);
    expect([...fake().storage['banner-media'].keys()]).toEqual([used.path]);
    expect(unused.path).not.toBe(used.path);
  });

  it('if the save succeeded but its answer was lost, closing the editor cannot delete the media the banner now uses (the server refuses)', async () => {
    const session = createUploadSession();
    const video = await uploadVideo(session);
    const poster = await uploadImage(session);
    await create({ active: true, desktopMediaType: 'video', desktopVideo: video.url, desktopImage: poster.url });
    await session.abandon(); // the browser believes the save failed
    expect([...fake().storage['banner-media'].keys()]).toEqual([video.path]);
    expect([...fake().storage.media.keys()]).toEqual([poster.path]);
    expect((await videoRemover(video.path)()).status).toBe(409);
    expect((await imageRemover(poster.path)()).status).toBe(409);
  });

  it('closing the editor after only uploading (nothing saved) deletes those files', async () => {
    const session = createUploadSession();
    await uploadVideo(session); await uploadImage(session);
    expect(fake().storage['banner-media'].size + fake().storage.media.size).toBe(2);
    await session.abandon();
    expect(fake().storage['banner-media'].size + fake().storage.media.size).toBe(0);
  });

  it('the editor keeps uploads only after the database save succeeded, and still closes if refreshing the list fails', () => {
    const source = readFileSync('components/admin/hero-banners.tsx', 'utf8');
    expect(source).toContain('const [session] = useState(createUploadSession)');
    expect(source).toContain('void session.abandon()');
    const savedFlag = source.indexOf('saved = true;');
    const commit = source.indexOf('await session.commit(');
    const afterSave = source.indexOf('onSaved(publish');
    expect(savedFlag).toBeGreaterThan(0);
    expect(commit).toBeGreaterThan(savedFlag);
    expect(afterSave).toBeGreaterThan(commit);
    expect(source).toMatch(/try \{ await onSaved\(publish[\s\S]*?\} catch \{/);
    expect(source).not.toContain('keepUploads');
    for (const file of ['components/admin/hero-video-uploader.tsx', 'components/admin/image-uploader.tsx']) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).toContain('session?.track(');
      expect(text, file).toContain('session?.forget(');
    }
  });
});

describe('optional video through the API and storage', () => {
  const videoRemover = (path: string) => () => call('DELETE', `/admin/uploads/banner-video?path=${encodeURIComponent(path)}`);
  const imageRemover = (path: string) => () => call('DELETE', `/admin/uploads?path=${encodeURIComponent(path)}`);
  const savedWithVideo = async () => {
    const setup = createUploadSession();
    const v = await upload('/admin/uploads/banner-video', MP4, 'v.mp4', 'video/mp4');
    const p = await upload('/admin/uploads', PNG, 'p.png', 'image/png');
    const video = { url: String(v.body.url), path: String(v.body.path) };
    const poster = { url: String(p.body.url), path: String(p.body.path) };
    const saved = await create({ active: true, desktopMediaType: 'video', desktopVideo: video.url, desktopImage: poster.url, mobileImage: '/images/m.webp' });
    await setup.commit([video.url, poster.url]);
    return { saved, video, poster };
  };

  it('image-only, video-only and image-plus-video banners all publish, with the stored type matching what is shown', async () => {
    const up = await upload('/admin/uploads/banner-video', MP4, 'v.mp4', 'video/mp4');
    const imageOnly = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopMediaType: 'image', desktopVideo: '' }));
    const videoOnly = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopMediaType: 'video', desktopVideo: String(up.body.url), desktopImage: '', mobileImage: '', useDesktopOnMobile: true }));
    const both = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopMediaType: 'video', desktopVideo: String(up.body.url), desktopImage: '/images/poster.webp' }));
    expect([imageOnly.status, videoOnly.status, both.status]).toEqual([201, 201, 201]);
    expect(imageOnly.body).toMatchObject({ desktopMediaType: 'image', desktopVideo: '' });
    expect(videoOnly.body).toMatchObject({ desktopMediaType: 'video', desktopImage: '' });
    expect(both.body).toMatchObject({ desktopMediaType: 'video', desktopImage: '/images/poster.webp' });
    expect((await listStore()).length).toBe(3);
  });

  it('a "video" slot whose file was removed publishes as an image banner and is stored that way (no error, nothing asks for a video)', async () => {
    const r = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopMediaType: 'video', desktopVideo: '', desktopImage: '/images/poster.webp' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ desktopMediaType: 'image', desktopVideo: '', desktopImage: '/images/poster.webp' });
    expect(fake().slides[0].desktop_media_type).toBe('image');
  });

  it('publishing with no media at all is refused with the image-or-video message, a draft is saved', async () => {
    const empty = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopImage: '', mobileImage: '', desktopMediaType: 'video' }));
    expect(empty.status).toBe(422);
    expect(JSON.stringify(empty.body)).toContain('desktopImage');
    expect(fake().slides).toHaveLength(0);
    const draft = await call('POST', '/admin/content/hero-slides', banner({ active: false, desktopImage: '', mobileImage: '', desktopMediaType: 'video' }));
    expect(draft.status).toBe(201);
  });

  it('removing a video and saving as image-only: the old video file goes only after the save, the poster image is kept and becomes the banner image', async () => {
    const { saved, video, poster } = await savedWithVideo();
    expect(fake().storage['banner-media'].has(video.path)).toBe(true);
    later();
    const edited = await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: '', desktopImage: poster.url, expectedUpdatedAt: saved.updatedAt }));
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ desktopMediaType: 'image', desktopVideo: '', desktopImage: poster.url });
    expect(fake().storage['banner-media'].has(video.path)).toBe(false); // removed after the save, nothing else uses it
    expect(fake().storage.media.has(poster.path)).toBe(true);           // the former poster is the banner image: never deleted
  });

  it('removing a video that another banner still uses never deletes the file', async () => {
    const { saved, video, poster } = await savedWithVideo();
    await call('POST', `/admin/content/hero-slides/${saved.id}/duplicate`); // shares the video and the poster
    later();
    await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'image', desktopVideo: '', desktopImage: poster.url, expectedUpdatedAt: saved.updatedAt }));
    expect(fake().storage['banner-media'].has(video.path)).toBe(true);
    expect(fake().storage.media.has(poster.path)).toBe(true);
  });

  it('a save that fails keeps the saved video and poster untouched, and abandoning the editor deletes only what the session uploaded', async () => {
    const { saved, video, poster } = await savedWithVideo();
    const session = createUploadSession();
    const fresh = await upload('/admin/uploads/banner-video', WEBM, 'new.webm', 'video/webm');
    session.track(String(fresh.body.url), videoRemover(String(fresh.body.path)));
    const before = JSON.stringify(fake().slides);
    // someone else changed the banner first, so this save (which removes the video) is refused
    later();
    await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: video.url, desktopImage: poster.url, title: 'Theirs', expectedUpdatedAt: saved.updatedAt }));
    const afterTheirs = JSON.stringify(fake().slides);
    later();
    const mine = await call('PUT', `/admin/content/hero-slides/${saved.id}`, banner({ active: true, desktopMediaType: 'video', desktopVideo: '', desktopImage: poster.url, expectedUpdatedAt: saved.updatedAt }));
    expect(mine.status).toBe(409);
    expect(JSON.stringify(fake().slides)).toBe(afterTheirs);
    expect(before).not.toBe(afterTheirs); // (their edit changed only the title)
    await session.abandon();
    expect([...fake().storage['banner-media'].keys()]).toEqual([video.path]);
    expect(fake().storage.media.has(poster.path)).toBe(true);
  });

  it('repeated video replacements and a final removal leave no orphaned objects, and a new image-only source is preserved', async () => {
    const session = createUploadSession();
    const upVideo = async (bytes = MP4, name = 'v.mp4', type = 'video/mp4') => { const r = await upload('/admin/uploads/banner-video', bytes, name, type); const entry = { url: String(r.body.url), path: String(r.body.path) }; session.track(entry.url, videoRemover(entry.path)); return entry; };
    const a = await upVideo(); const b = await upVideo(WEBM, 'b.webm', 'video/webm'); const c = await upVideo();
    const img = await upload('/admin/uploads', PNG, 'p.png', 'image/png');
    const image = { url: String(img.body.url), path: String(img.body.path) };
    session.track(image.url, imageRemover(image.path));
    expect(fake().storage['banner-media'].size).toBe(3);
    // the admin removes the video (back to an image-only banner) and publishes with the new image
    const saved = await call('POST', '/admin/content/hero-slides', banner({ active: true, desktopMediaType: 'video', desktopVideo: '', desktopImage: image.url }));
    expect(saved.status).toBe(201);
    await session.commit([image.url]); // the saved banner uses only the image
    expect(fake().storage['banner-media'].size).toBe(0);
    expect([...fake().storage.media.keys()]).toEqual([image.path]);
    expect([a.path, b.path, c.path].some(path => fake().storage['banner-media'].has(path))).toBe(false);
  });
});

describe('authorisation', () => {
  it('every banner and upload operation needs an admin session', async () => {
    h.role = null;
    const id = '11111111-1111-1111-1111-111111111111';
    expect((await call('POST', '/admin/content/hero-slides', banner())).status).toBe(401);
    expect((await call('PUT', `/admin/content/hero-slides/${id}`, banner())).status).toBe(401);
    expect((await call('DELETE', `/admin/content/hero-slides/${id}`)).status).toBe(401);
    expect((await call('POST', `/admin/content/hero-slides/${id}/duplicate`)).status).toBe(401);
    expect((await call('PUT', '/admin/content/hero-slides/order', { ids: [id] })).status).toBe(401);
    expect((await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4')).status).toBe(401);
    expect((await upload('/admin/uploads', PNG, 'a.png', 'image/png')).status).toBe(401);
    expect(fake().slides).toHaveLength(0);
    expect(fake().storage['banner-media'].size).toBe(0);
  });
  it('a support-only account cannot manage banners or upload their media', async () => {
    h.role = 'support';
    expect((await call('POST', '/admin/content/hero-slides', banner())).status).toBe(403);
    expect((await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4')).status).toBe(403);
    expect(fake().slides).toHaveLength(0);
  });
  it('writes need the CSRF token', async () => {
    const response = await handleBackendRequest(new Request('https://one21eight.test/api/v1/admin/content/hero-slides', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 's=session' }, body: JSON.stringify(banner()) }));
    expect(response.status).toBe(403);
  });
});

describe('storefront visibility and backward compatibility', () => {
  it('shows only live banners, in saved order, with their device media', async () => {
    const a = await create({ title: 'A', active: true });
    const b = await create({ title: 'B', active: false });
    const c = await create({ title: 'C', active: true, desktopMediaType: 'video', desktopVideo: 'https://p.supabase.co/storage/v1/object/public/banner-media/banners/2026/11/33333333-3333-3333-3333-333333333333.mp4', desktopImage: '' });
    const store = await listStore();
    expect(store.map(s => s.id)).toEqual([a.id, c.id]);
    expect(store.map(s => s.id)).not.toContain(b.id);
    expect(store[1]).toMatchObject({ desktopMediaType: 'video', desktopImage: '', mobileImage: '/images/b.webp' });
  });

  it('a banner saved before migration 0010 renders exactly as before: image slots, its own mobile image', () => {
    const legacy = heroDto({ id: 'x', kicker: 'k', title: 'ELEVATED ESSENTIALS', body: 'b', desktop_image: '/images/campaign/menswear-editorial-wide.webp', mobile_image: 'uploads/2026/10/m.webp', cta: '', href: '/collections/all', active: true, sort_order: 1 });
    expect(legacy).toMatchObject({
      title: 'ELEVATED ESSENTIALS', href: '/collections/all', active: true,
      desktopImage: '/images/campaign/menswear-editorial-wide.webp', mobileImage: 'https://p.supabase.co/storage/v1/object/public/media/uploads/2026/10/m.webp',
      desktopMediaType: 'image', mobileMediaType: 'image', desktopVideo: '', mobileVideo: '', useDesktopOnMobile: false, altText: '',
    });
  });

  it('an older admin payload without any of the new fields still saves and keeps image behaviour', async () => {
    const created = await create({ title: 'Old style', active: true });
    later();
    const legacyBody = { kicker: '', title: 'Old style', body: 'Copy', cta: '', href: '/collections/all', active: true, desktopImage: '/images/a.webp', mobileImage: '/images/b.webp' };
    const saved = await call('PUT', `/admin/content/hero-slides/${created.id}`, legacyBody);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ desktopMediaType: 'image', mobileMediaType: 'image', useDesktopOnMobile: false, desktopImage: '/images/a.webp', mobileImage: '/images/b.webp' });
  });

  it('before the migration the storefront and admin list still work, and writes explain what is missing instead of failing blindly', async () => {
    useDb(createFakeHeroDb({ migrated: false }));
    fake().seed({ title: 'Legacy A', sort_order: 1 });
    fake().seed({ title: 'Legacy B', sort_order: 2, active: false });
    expect((await listStore()).map(s => s.title)).toEqual(['Legacy A']);
    expect((await listAdmin()).map(s => s.title)).toEqual(['Legacy A', 'Legacy B']);
    const blocked = await call('POST', '/admin/content/hero-slides', banner());
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('migration_required');
    const id = fake().slides[0].id;
    expect((await call('PUT', '/admin/content/hero-slides/order', { ids: [fake().slides[1].id, id] })).body.error.code).toBe('migration_required');
    expect((await upload('/admin/uploads/banner-video', MP4, 'a.mp4', 'video/mp4')).body).toMatchObject({ error: { code: 'migration_required' } });
  });
});

describe('admin screen safeguards', () => {
  const source = readFileSync('components/admin/hero-banners.tsx', 'utf8');
  it('ignores a second click while a save or another action is running, and disables Save while saving or uploading', () => {
    expect(source).toContain('if (saveLock.current || uploading) return;');
    expect(source).toContain('disabled={saving || uploading}');
    expect(source).toContain('if (lock.current) return;');
  });
  it('uses the in-app confirmation dialog, never the browser dialogs', () => {
    expect(source).toContain('useConfirm');
    expect(source).not.toMatch(/window\.(confirm|alert|prompt)\(|[^.\w](confirm|alert|prompt)\((?!\{)/);
  });
  it('has a clearly visible primary "Add New Banner" action', () => {
    expect(source).toMatch(/admin-primary-btn hb-add[\s\S]*?<Plus size=\{15\} \/> Add New Banner/);
  });
});
