import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvCache } from '@/lib/env';
import { MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_LABEL } from '@/lib/upload-limits';

// Database spy (same approach as checkout-auth.test.ts): proves what an upload request does and does not touch.
const dbSpy = vi.hoisted(() => ({ tables: [] as string[], uploads: 0, rows: {} as Record<string, unknown> }));
vi.mock('@/lib/backend/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/backend/core')>();
  const chain = (table: string): unknown => new Proxy(() => undefined, {
    get: (_target, prop) => prop === 'then' ? undefined : prop === 'maybeSingle' || prop === 'single' ? async () => ({ data: dbSpy.rows[table] ?? null, error: null }) : () => chain(table),
  });
  return { ...actual, db: () => ({ from: (table: string) => { dbSpy.tables.push(table); return chain(table); }, storage: { from: () => ({ upload: async () => { dbSpy.uploads += 1; return { error: null }; } }) } }) };
});
const { handleBackendRequest } = await import('@/lib/backend/core');
await import('@/lib/backend');

const saved = { ...process.env };
beforeEach(() => {
  Object.assign(process.env, { APP_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a' });
  resetServerEnvCache();
  dbSpy.tables = []; dbSpy.uploads = 0;
  dbSpy.rows = { admin_sessions: { expires_at: new Date(Date.now() + 60_000).toISOString(), admin_users: { id: 'a1', email: 'qa@example.com', name: 'QA', role: 'owner', active: true } } };
});
afterEach(() => { process.env = { ...saved }; resetServerEnvCache(); });

const png = (size: number) => { const bytes = new Uint8Array(size); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return bytes; };
const upload = (bytes: Uint8Array, { session = true, headers = {} as Record<string, string> } = {}) => {
  const form = new FormData();
  form.set('file', new File([bytes as BlobPart], 'photo.png', { type: 'image/png' }));
  return handleBackendRequest(new Request('http://backend.local/api/v1/admin/uploads', {
    method: 'POST', body: form,
    headers: { cookie: `o218_csrf=csrf1${session ? '; o218_admin_session=tok' : ''}`, 'x-csrf-token': 'csrf1', ...headers },
  }));
};

describe('admin image upload limit (temporary 4 MB, Vercel compatibility)', () => {
  it('is exactly 4 MB, shared by the browser and the server', () => {
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_IMAGE_UPLOAD_LABEL).toBe('4 MB');
    expect(readFileSync('components/admin/image-uploader.tsx', 'utf8')).toContain("from '@/lib/upload-limits'");
    expect(readFileSync('lib/backend/routes/admin.ts', 'utf8')).toContain("from '@/lib/upload-limits'");
  });
  it('no 5 MB wording is left in the admin UI, the upload route or the API contract', () => {
    for (const file of ['components/admin/image-uploader.tsx', 'components/admin/products.tsx', 'components/admin/collections.tsx', 'lib/backend/routes/admin.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\b5 ?MB\b|5 \* 1024/i);
    }
    expect(readFileSync('openapi/openapi.yaml', 'utf8')).not.toMatch(/max 5 MB/);
  });
  it('the server independently rejects a file over 4 MB with 413 and stores nothing', async () => {
    const response = await upload(png(MAX_IMAGE_UPLOAD_BYTES + 1));
    expect(response.status).toBe(413);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('file_too_large');
    expect(body.error.message).toBe('Images must be 4 MB or smaller.');
    expect(dbSpy.uploads).toBe(0);
  });
  it('rejects early on a declared Content-Length above the limit, before reading the body', async () => {
    const response = await upload(png(16), { headers: { 'content-length': String(MAX_IMAGE_UPLOAD_BYTES + 1024 * 1024) } });
    expect(response.status).toBe(413);
    expect(dbSpy.uploads).toBe(0);
  });
  it('a valid image of exactly 4 MB is accepted and stored; the old 5 MB ceiling is gone', async () => {
    const response = await upload(png(MAX_IMAGE_UPLOAD_BYTES));
    expect(response.status).toBe(201);
    expect(dbSpy.uploads).toBe(1);
    expect((await upload(png(5 * 1024 * 1024))).status).toBe(413);
  });
  it('still verifies the file type from its bytes, and still requires an admin session', async () => {
    const notAnImage = new Uint8Array(1024);
    expect((await upload(notAnImage)).status).toBe(422);
    expect(dbSpy.uploads).toBe(0);
    dbSpy.tables = [];
    expect((await upload(png(1024), { session: false })).status).toBe(401);
    expect(dbSpy.uploads).toBe(0);
  });
});
