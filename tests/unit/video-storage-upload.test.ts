/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed Supabase stand-ins */
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ env: { siteUrl: 'https://one21eight.test', apiMode: 'supabase', supabase: { url: 'https://p.supabase.co', serviceRoleKey: 'test-key', anonKey: 'a' }, adminSessionCookie: 's', razorpay: null, emailProvider: 'resend' } }));
vi.mock('@/lib/env', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/env')>()), getServerEnv: () => h.env }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ storage: { getBucket: async () => ({ data: null, error: null }), from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) } }) }));

import { assertFinalFormat, storeBannerVideo, storeBannerVideoFile } from '@/lib/backend/banner-storage';
import { videoConfig } from '@/lib/backend/video-transcode';
import { DEFAULT_MAX_OUTPUT_BYTES } from '@/lib/video-plan';

const LIMIT = 45_000_000;
let dir = '';
beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'o218-store-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.HERO_VIDEO_UPLOAD_IDLE_S; delete process.env.HERO_VIDEO_MAX_OUTPUT_MB; });

/** A sparse file of exactly `size` bytes that starts with a valid MP4 (or other) header. */
async function fileOf(name: string, size: number, header = 'ftypisom') {
  const file = path.join(dir, name); const handle = await open(file, 'w');
  await handle.write(Buffer.from([0, 0, 0, 24]), 0, 4, 0); await handle.write(Buffer.from(header, 'latin1'), 0, 8, 4); await handle.truncate(size); await handle.close();
  return file;
}
const drain = async (body: ReadableStream<Uint8Array>) => { const r = body.getReader(); let total = 0; for (;;) { const { done, value } = await r.read(); if (done) break; total += value.byteLength; } return total; };
const posts = (spy: any) => (spy.mock.calls as any[][]).filter(call => (call[1] as RequestInit | undefined)?.method === 'POST');
/** Storage that stores everything and answers HEAD with 200. */
const okStorage = () => vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: any, init?: RequestInit) => {
  if (init?.method === 'POST') { await drain(init.body as ReadableStream<Uint8Array>); return Response.json({ Key: 'ok' }); }
  return new Response(null, { status: 200 });
}) as any);
const reply = (status: number, body: object) => vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: any, init?: RequestInit) => {
  if (init?.method === 'POST') { await drain(init.body as ReadableStream<Uint8Array>); return Response.json(body, { status }); }
  return new Response(null, { status: 200 });
}) as any);
const fail = async (promise: Promise<unknown>) => { try { await promise; } catch (e) { return e as { status: number; code: string; message: string }; } throw new Error('expected a failure'); };

describe('effective processed-output limit: 45,000,000 bytes', () => {
  it('is the default, shared by the backend config, and overridable by HERO_VIDEO_MAX_OUTPUT_MB', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(LIMIT); expect(videoConfig().maxOutputBytes).toBe(LIMIT);
    process.env.HERO_VIDEO_MAX_OUTPUT_MB = '60'; expect(videoConfig().maxOutputBytes).toBe(60 * 1024 * 1024);
  });
  it.each([[44_999_999, true], [45_000_000, true], [45_000_001, false]])('file of %i bytes is accepted: %s (before anything is sent)', async (size, accepted) => {
    const spy = okStorage();
    const file = await fileOf(`b-${size}.mp4`, size);
    if (accepted) {
      const stored = await storeBannerVideoFile(file, size, 'mp4', 'video/mp4');
      expect(stored.path).toMatch(/^banners\/\d{4}\/\d{2}\/.+\.mp4$/);
      const post = posts(spy); expect(post).toHaveLength(1);
      expect((post[0][1] as any).headers['content-length']).toBe(String(size)); expect((post[0][1] as any).headers['content-type']).toBe('video/mp4');
    } else {
      const error = await fail(storeBannerVideoFile(file, size, 'mp4', 'video/mp4'));
      expect(error).toMatchObject({ status: 413, code: 'file_too_large' }); expect(error.message).toContain('45,000,000 bytes');
      expect(posts(spy)).toHaveLength(0); // refused locally: not one byte was sent
    }
  }, 60_000);
  it('the in-memory path (single-request upload) has the same boundary', async () => {
    okStorage();
    const make = (size: number) => { const b = new Uint8Array(size); b.set(Buffer.from('ftypisom', 'latin1'), 4); return b; };
    await expect(storeBannerVideo(make(LIMIT), 'mp4', 'video/mp4')).resolves.toMatchObject({ path: expect.stringMatching(/\.mp4$/) });
    await expect(storeBannerVideo(make(LIMIT + 1), 'mp4', 'video/mp4')).rejects.toMatchObject({ status: 413, code: 'file_too_large' });
  }, 60_000);
});

describe('the final file must be an allowed type before anything is uploaded', () => {
  it('accepts only video/mp4 (an ISO MP4) and video/webm (EBML)', () => {
    const mp4 = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom')]);
    expect(() => assertFinalFormat('mp4', 'video/mp4', mp4)).not.toThrow();
    expect(() => assertFinalFormat('webm', 'video/webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).not.toThrow();
  });
  it('refuses a QuickTime MOV, a wrong MIME type, a wrong extension and a corrupt header', async () => {
    const spy = okStorage();
    const mov = await fileOf('x.mp4', 2048, 'ftypqt  ');
    expect(await fail(storeBannerVideoFile(mov, 2048, 'mp4', 'video/mp4'))).toMatchObject({ status: 422, code: 'verify_failed' });
    const ok = await fileOf('y.mp4', 2048);
    expect(await fail(storeBannerVideoFile(ok, 2048, 'mp4', 'video/quicktime'))).toMatchObject({ status: 422, code: 'unsupported_type' });
    expect(await fail(storeBannerVideoFile(ok, 2048, 'mov' as 'mp4', 'video/mp4'))).toMatchObject({ code: 'unsupported_type' });
    const junk = await fileOf('z.mp4', 2048, 'not-mp4!');
    expect(await fail(storeBannerVideoFile(junk, 2048, 'mp4', 'video/mp4'))).toMatchObject({ code: 'verify_failed' });
    expect(posts(spy)).toHaveLength(0);
  });
});

describe('Supabase HTTP errors are preserved and distinct from network failures and timeouts', () => {
  const cases: [number, object, string, RegExp][] = [
    [413, { message: 'The object exceeded the maximum allowed size', statusCode: '413' }, 'file_too_large', /too large/i],
    [401, { message: 'Invalid JWT', statusCode: '401' }, 'storage_unauthorized', /credentials/i],
    [403, { message: 'new row violates row-level security policy', statusCode: '403' }, 'storage_unauthorized', /credentials/i],
    [404, { message: 'Bucket not found', statusCode: '404' }, 'migration_required', /bucket/i],
    [409, { message: 'The resource already exists', statusCode: '409' }, 'upload_conflict', /already exists/i],
    [415, { message: 'mime type video/quicktime is not supported', statusCode: '415' }, 'unsupported_type', /does not accept/i],
    [503, { message: 'Service temporarily unavailable', statusCode: '503' }, 'upload_failed', /HTTP 503/],
  ];
  it.each(cases)('HTTP %i keeps its own meaning', async (status, body, code, text) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reply(status, body);
    const file = await fileOf(`e-${status}.mp4`, 4096);
    const error = await fail(storeBannerVideoFile(file, 4096, 'mp4', 'video/mp4'));
    expect(error.code).toBe(code); expect(error.message).toMatch(text);
  });
  it('only a real 413 is described as a size problem', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = await fileOf('size.mp4', 4096);
    const messages: Record<string, string> = {};
    for (const [label, rejection] of [['reset', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })], ['dns', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })], ['refused', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })]] as const) {
      vi.spyOn(globalThis, 'fetch').mockImplementation((async (_i: any, init?: RequestInit) => { if (init?.method === 'POST') { void drain(init.body as ReadableStream<Uint8Array>).catch(() => undefined); throw rejection; } return new Response(null, { status: 200 }); }) as any);
      const error = await fail(storeBannerVideoFile(file, 4096, 'mp4', 'video/mp4'));
      messages[label] = `${error.code}|${error.message}`;
      expect(error.code).not.toBe('file_too_large'); expect(error.message).not.toMatch(/too large|exceeded|maximum allowed size/i);
      vi.restoreAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    }
    expect(messages.reset.split('|')[0]).toBe('storage_connection_dropped');
    expect(messages.dns.split('|')[0]).toBe('storage_unreachable');
    expect(messages.refused.split('|')[0]).toBe('storage_unreachable');
  });
  it('a stalled upload is a timeout (storage_timeout, 504), not a size or network-reset error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.HERO_VIDEO_UPLOAD_IDLE_S = '5';
    vi.spyOn(globalThis, 'fetch').mockImplementation(((_i: any, init?: RequestInit) => init?.method === 'POST'
      ? new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
      : Promise.resolve(new Response(null, { status: 200 }))) as any);
    const file = await fileOf('stall.mp4', 4096);
    const error = await fail(storeBannerVideoFile(file, 4096, 'mp4', 'video/mp4'));
    expect(error).toMatchObject({ status: 504, code: 'storage_timeout' }); expect(error.message).toMatch(/stopped making progress/); expect(error.message).not.toMatch(/too large|reset/i);
  }, 30_000);
});
