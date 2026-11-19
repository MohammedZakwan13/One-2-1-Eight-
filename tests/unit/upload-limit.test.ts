import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvCache } from '@/lib/env';
import {
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_LABEL,
  MAX_ORIGINAL_IMAGE_BYTES,
  MAX_ORIGINAL_IMAGE_LABEL,
} from '@/lib/upload-limits';

// Database spy: proves what an upload request does and does not touch.
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

const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

const upload = (bytes: Uint8Array, { session = true, headers = {} as Record<string, string> } = {}) => {
  const form = new FormData();
  form.set('file', new File([bytes as BlobPart], 'photo.png', { type: 'image/png' }));
  return handleBackendRequest(new Request('http://backend.local/api/v1/admin/uploads', {
    method: 'POST', body: form,
    headers: { cookie: `o218_csrf=csrf1${session ? '; o218_admin_session=tok' : ''}`, 'x-csrf-token': 'csrf1', ...headers },
  }));
};

describe('admin image upload limit (10 MB target, 50 MB source limit)', () => {
  it('is exactly 10 MB upload target and 50 MB source ceiling, shared across modules', () => {
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_IMAGE_UPLOAD_LABEL).toBe('10 MB');
    expect(MAX_ORIGINAL_IMAGE_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_ORIGINAL_IMAGE_LABEL).toBe('50 MB');
    expect(readFileSync('components/admin/image-uploader.tsx', 'utf8')).toContain("from '@/lib/upload-limits'");
    expect(readFileSync('lib/backend/routes/admin.ts', 'utf8')).toContain("from '@/lib/upload-limits'");
  });

  it('admin UI, upload routes and API contract reflect the 10 MB limit and auto-optimization', () => {
    for (const file of ['components/admin/image-uploader.tsx', 'components/admin/products.tsx', 'components/admin/collections.tsx', 'lib/backend/routes/admin.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\b4 ?MB\b|\b4 \* 1024\b/i);
    }
    expect(readFileSync('openapi/openapi.yaml', 'utf8')).toContain('max 10 MB');
  });

  it('the server independently rejects an uploaded file over 10 MB with 413 and stores nothing', async () => {
    const response = await upload(png(MAX_IMAGE_UPLOAD_BYTES + 1));
    expect(response.status).toBe(413);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('file_too_large');
    expect(body.error.message).toBe('Images must be 10 MB or smaller.');
    expect(dbSpy.uploads).toBe(0);
  });

  it('rejects early on a declared Content-Length above 10 MB, before reading the body', async () => {
    const response = await upload(png(16), { headers: { 'content-length': String(MAX_IMAGE_UPLOAD_BYTES + 1024 * 1024) } });
    expect(response.status).toBe(413);
    expect(dbSpy.uploads).toBe(0);
  });

  it('a valid image of exactly 10 MB is accepted and stored', async () => {
    const response = await upload(png(MAX_IMAGE_UPLOAD_BYTES));
    expect(response.status).toBe(201);
    expect(dbSpy.uploads).toBe(1);
    expect((await upload(png(10 * 1024 * 1024 + 1024))).status).toBe(413);
  });

  it('multipart/form-data overhead does not cause false 413 rejections for images close to 10 MB', async () => {
    // When a 10 MB image is posted in multipart/form-data, Content-Length includes boundary & headers
    // e.g. Content-Length = 10,485,760 + 512 bytes = 10,486,272 bytes.
    const validImageBytes = MAX_IMAGE_UPLOAD_BYTES; // exact 10 MB file
    const declaredMultipartLength = validImageBytes + 1024; // 1 KB multipart framing overhead
    const response = await upload(png(validImageBytes), {
      headers: { 'content-length': String(declaredMultipartLength) },
    });
    expect(response.status).toBe(201);
    expect(dbSpy.uploads).toBe(1);

    // Conversely, if the file itself exceeds 10 MB (e.g. 10 MB + 1 byte), it is rejected with 413
    const oversizedFile = await upload(png(MAX_IMAGE_UPLOAD_BYTES + 1), {
      headers: { 'content-length': String(MAX_IMAGE_UPLOAD_BYTES + 1 + 1024) },
    });
    expect(oversizedFile.status).toBe(413);
  });

  it('still verifies the file type from its magic bytes, and still requires an admin session', async () => {
    const notAnImage = new Uint8Array(1024);
    expect((await upload(notAnImage)).status).toBe(422);
    expect(dbSpy.uploads).toBe(0);
    dbSpy.tables = [];
    expect((await upload(png(1024), { session: false })).status).toBe(401);
    expect(dbSpy.uploads).toBe(0);
  });
});
