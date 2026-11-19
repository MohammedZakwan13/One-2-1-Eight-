import { readFileSync } from 'node:fs';
/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers read loosely typed API JSON */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHeroDb, type FakeHeroDb } from './helpers/fake-hero-db';
import { mp4 } from './helpers/media-fixtures';

const h = vi.hoisted(() => ({
  db: null as unknown,
  role: 'owner' as 'owner' | null,
  adminId: 'a1',
  freeBytes: 1e15,
  ffmpeg: true,
  /** What the pretend converter does for the next job. */
  convert: null as null | ((outDir: string) => Promise<unknown>),
  lastMode: '' as string,
  env: { siteUrl: 'https://one21eight.test', apiMode: 'supabase', supabase: { url: 'https://p.supabase.co', serviceRoleKey: 'k', anonKey: 'a' }, adminSessionCookie: 's', razorpay: null, emailProvider: 'resend' },
}));

vi.mock('@/lib/env', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/env')>()), getServerEnv: () => h.env }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.db }));
vi.mock('@/lib/backend/auth', async importOriginal => {
  const { HttpError } = await import('@/lib/backend/core');
  return {
    ...(await importOriginal<typeof import('@/lib/backend/auth')>()),
    requireAdmin: async () => { if (!h.role) throw new HttpError(401, 'unauthorized', 'Please sign in to continue.'); return { id: h.adminId, email: 'a@b.co', name: 'A', role: h.role }; },
  };
});
vi.mock('node:fs/promises', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs/promises')>()), statfs: async () => ({ bavail: h.freeBytes, bsize: 1 }) }));
vi.mock('@/lib/backend/video-transcode', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/backend/video-transcode')>()),
  ffmpegAvailable: async () => h.ffmpeg,
  requireFfmpeg: async () => { if (!h.ffmpeg) throw new (await importOriginal<typeof import('@/lib/backend/video-transcode')>()).VideoError('unavailable', 'Video processing is not available on this server: FFmpeg (with the H.264 and AAC encoders) is not installed.'); },
  processVideo: async (_input: string, outDir: string, options?: { mode?: string }) => { h.lastMode = options?.mode ?? ''; return h.convert!(outDir); },
}));

import { handleBackendRequest } from '@/lib/backend';
import { VideoError } from '@/lib/backend/video-transcode';
import { resetVideoJobsForTests } from '@/lib/backend/video-jobs';
import { resetUploadSessionsForTests } from '@/lib/backend/video-uploads';
import { FINAL_MAX_BYTES } from '@/lib/video-plan';

const MiB = 1024 * 1024;
const CSRF = 'csrf-token';
const fake = () => h.db as FakeHeroDb;
const headers = () => ({ 'x-csrf-token': CSRF, cookie: `o218_csrf=${CSRF}; s=session` });
let tmp = '';

async function post(bytes: Uint8Array, name: string, type: string) {
  const form = new FormData(); form.append('file', new File([bytes as BlobPart], name, { type }));
  const response = await handleBackendRequest(new Request('https://one21eight.test/api/v1/admin/uploads/banner-video', { method: 'POST', headers: headers(), body: form }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function getJob(id: string) {
  const response = await handleBackendRequest(new Request(`https://one21eight.test/api/v1/admin/uploads/banner-video/jobs/${id}`, { method: 'GET', headers: headers() }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const finished = async (id: string) => { let job: Record<string, any> = {}; await vi.waitFor(async () => { job = (await getJob(id)).body; expect(['ready', 'failed']).toContain(job.status); }, { timeout: 20000, interval: 25 }); return job; };
const output = (bytes: number, action: 'reencoded' | 'remuxed' | 'preserved' = 'reencoded') => async (outDir: string) => {
  const file = path.join(outDir, 'output.mp4'); const content = Buffer.alloc(bytes, 7); content.write('ftypisom', 4, 'latin1'); await writeFile(file, content); // a real MP4 header, as the converter produces
  const note = { level: 'info' as const, text: 'Resolution reduced from 3840×2160 to 1920×1080.' };
  const facts = (w: number, hgt: number, b: number) => ({ bytes: b, width: w, height: hgt, fps: 30, videoCodec: 'h264', audioCodec: 'aac' });
  const info = { mode: 'balanced', action, preserved: action === 'preserved', remuxed: action === 'remuxed', reencoded: action === 'reencoded', resized: action === 'reencoded', summary: 'ok', attempts: 1,
    original: { ...facts(3840, 2160, 30 * MiB), container: 'mov', durationSeconds: 8 }, final: { ...facts(1920, 1080, bytes), container: 'mp4' as const }, notes: action === 'reencoded' ? [note] : [] };
  return { path: file, ext: 'mp4', mime: 'video/mp4', bytes, width: 1920, height: 1080, duration: 8, audioCodec: 'aac', info, warnings: info.notes.map(n => n.text) };
};
const big = (mib: number) => new Uint8Array(mib * MiB).fill(1);
const jobFolders = async () => (await readdir(tmp).catch(() => [] as string[])).filter(name => name !== 'uploads').length;
const leftovers = async () => (await readdir(tmp).catch(() => [])).length;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'o218-jobs-'));
  process.env.HERO_VIDEO_TMP_DIR = tmp; delete process.env.HERO_VIDEO_MAX_SOURCE_MB; delete process.env.HERO_VIDEO_MAX_QUEUE; delete process.env.HERO_VIDEO_CONCURRENCY;
  h.db = createFakeHeroDb(); h.role = 'owner'; h.ffmpeg = true; h.convert = output(9 * MiB);
  delete (globalThis as Record<string, unknown>).__o218_supabase__; resetVideoJobsForTests(); resetUploadSessionsForTests(); h.adminId = 'a1'; h.freeBytes = 1e15;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // The processed file is streamed to Storage with a plain fetch (progress + stall detection), so the fake Storage lives behind fetch here.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input); const marker = '/storage/v1/object/banner-media/';
    if (init?.method === 'POST' && url.includes(marker)) {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader(); for (;;) { const { done } = await reader.read(); if (done) break; }
      const failure = (fake() as FakeHeroDb & { uploadFailure: { message: string; status?: number } | null }).uploadFailure;
      if (failure) return Response.json({ message: failure.message, statusCode: String(failure.status ?? 500) }, { status: failure.status ?? 500 });
      fake().storage['banner-media'].set(url.split(marker)[1], { created_at: new Date().toISOString() });
      return Response.json({ Key: 'ok' }, { status: 200 });
    }
    return new Response(null, { status: 200 });
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }); // a finishing background job may still hold a handle on Windows

describe('already-compatible small videos keep the instant path', () => {
  it('stores a compatible MP4 as it is: 201, no job, no re-encoding, sizes reported', async () => {
    const bytes = mp4();
    const r = await post(bytes, 'a.mp4', 'video/mp4');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ converted: false, originalBytes: bytes.byteLength, processedBytes: bytes.byteLength });
    expect(r.body.jobId).toBeUndefined();
    expect(fake().storage['banner-media'].size).toBe(1);
  });
});

describe('conversion of other formats and larger files (FFmpeg available)', () => {
  it('accepts a MOV, answers 202 immediately, and later reports a ready file with original and processed sizes and the processing info', async () => {
    const r = await post(big(30), 'clip.mov', 'video/quicktime');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: expect.stringMatching(/queued|processing/), originalBytes: 30 * MiB, originalName: 'clip.mov' });
    const job = await finished(r.body.jobId);
    expect(job).toMatchObject({ status: 'ready', converted: true, originalBytes: 30 * MiB, processedBytes: 9 * MiB });
    expect(job.processedBytes).toBeLessThanOrEqual(FINAL_MAX_BYTES); // the configurable output safeguard, not a quality target
    expect(job.url).toMatch(/\/banner-media\/banners\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.mp4$/);
    expect(job.warnings.join(' ')).toMatch(/Resolution reduced from 3840×2160 to 1920×1080/);
    expect(job.info).toMatchObject({ action: 'reencoded', resized: true, original: { width: 3840, height: 2160 }, final: { width: 1920, height: 1080 } });
    expect(job.mode).toBe('original'); expect(h.lastMode).toBe('original'); // the default mode is original quality
    expect(job.processingMs).toBeGreaterThanOrEqual(0);
    expect([...fake().storage['banner-media'].keys()]).toEqual([job.path]); // the processed file is the only stored object
  });
  it.each([['a.mkv', 'video/x-matroska', 15], ['b.avi', 'video/x-msvideo', 20], ['c.wmv', '', 30], ['d.flv', 'video/x-flv', 40], ['e.mpeg', 'video/mpeg', 50], ['f.m4v', 'video/x-m4v', 13], ['g.3gp', 'video/3gpp', 14]])('accepts %s (%i MB original) for conversion', async (name, type, mib) => {
    const r = await post(big(mib), name, type);
    expect(r.status).toBe(202);
    expect((await finished(r.body.jobId)).status).toBe('ready');
  });
  it('a single request carries at most what one request can (95 MB) and the message points to the chunked upload, which has no cap', async () => {
    const r = await post(big(100), 'huge.mov', 'video/quicktime');
    expect(r.status).toBe(413);
    expect(r.body.error.message).toMatch(/chunked upload/);
    expect(r.body.error.message).not.toMatch(/12 MB or smaller|MP4 or WebM only/i);
  });
  it('a failed conversion reports the reason, leaves no storage object and no temp files', async () => {
    h.convert = async () => { throw new VideoError('cannot_fit', 'This 150-second video cannot be compressed to 12 MB without looking poor.'); };
    const r = await post(big(30), 'long.mov', 'video/quicktime');
    const job = await finished(r.body.jobId);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'cannot_fit' } });
    expect(job.error.message).toMatch(/12 MB/);
    expect(fake().storage['banner-media'].size).toBe(0);
    await vi.waitFor(async () => expect(await leftovers()).toBe(0));
  });
  it('a failed storage upload fails the job honestly (no "ready"), with temp files removed', async () => {
    (fake() as FakeHeroDb & { uploadFailure: unknown }).uploadFailure = { message: 'storage down' };
    const r = await post(big(30), 'clip.mov', 'video/quicktime');
    const job = await finished(r.body.jobId);
    expect(job.status).toBe('failed');
    expect(job.url).toBeUndefined();
    expect(fake().storage['banner-media'].size).toBe(0);
    await vi.waitFor(async () => expect(await leftovers()).toBe(0));
  });
  it('an unexpected crash in the converter is reported without leaking internals', async () => {
    h.convert = async () => { throw new Error('/secret/path ENOENT'); };
    const job = await finished((await post(big(20), 'x.mov', 'video/quicktime')).body.jobId);
    expect(job.status).toBe('failed');
    expect(JSON.stringify(job)).not.toContain('/secret/path');
  });
  it('removes the temporary raw upload after success too', async () => {
    const job = await finished((await post(big(20), 'x.mov', 'video/quicktime')).body.jobId);
    expect(job.status).toBe('ready');
    await vi.waitFor(async () => expect(await leftovers()).toBe(0));
  });
  it('protects the server: one encode at a time and a short queue; extra uploads are told to wait', async () => {
    process.env.HERO_VIDEO_MAX_QUEUE = '1';
    let release: () => void = () => undefined;
    h.convert = async (outDir: string) => { await new Promise<void>(resolve => { release = resolve; }); return output(5 * MiB)(outDir); };
    const first = await post(big(20), 'a.mov', 'video/quicktime');
    const second = await post(big(20), 'b.mov', 'video/quicktime');
    const third = await post(big(20), 'c.mov', 'video/quicktime');
    expect([first.status, second.status, third.status]).toEqual([202, 202, 429]);
    expect(third.body.error.code).toBe('video_busy');
    release();
    await vi.waitFor(async () => expect((await getJob(second.body.jobId)).body.stage).not.toBe('queued'));
    release();
    expect((await finished(first.body.jobId)).status).toBe('ready');
    expect((await finished(second.body.jobId)).status).toBe('ready');
  });
  it('job status needs an admin, and an unknown or malformed id is a clear 404', async () => {
    expect((await getJob('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await getJob('not-a-uuid')).status).toBe(404);
    h.role = null;
    expect((await getJob('00000000-0000-4000-8000-000000000000')).status).toBe(401);
  });
});

describe('without FFmpeg there is NO fallback to the old rules: the answer says exactly what is missing', () => {
  beforeEach(() => { h.ffmpeg = false; });
  it('single-request and chunked uploads both fail with 503 media_processing_unavailable (never a 12 MB or format message)', async () => {
    for (const r of [await post(mp4(), 'ok.mp4', 'video/mp4'), await post(big(13), 'big.mp4', 'video/mp4'), await post(new TextEncoder().encode('xx'), 'clip.mov', 'video/quicktime'), await call('POST', '/admin/uploads/banner-video/sessions', { name: 'a.mov', size: 5 * MiB })]) {
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('media_processing_unavailable');
      expect(r.body.error.message).toMatch(/FFmpeg/);
      expect(r.body.error.message).not.toMatch(/12 MB or smaller|only MP4|WebM/i);
    }
    expect(fake().storage['banner-media'].size).toBe(0);
  });
});

// ── chunked, resumable uploads ──
const json = (body: unknown) => ({ 'content-type': 'application/json', ...headersOf(), body: JSON.stringify(body) });
function headersOf() { return { 'x-csrf-token': CSRF, cookie: `o218_csrf=${CSRF}; s=session` }; }
async function call(method: string, path: string, body?: unknown) {
  const response = await handleBackendRequest(new Request(`https://one21eight.test/api/v1${path}`, { method, ...(body === undefined ? { headers: headersOf() } : { headers: { 'content-type': 'application/json', ...headersOf() }, body: JSON.stringify(body) }) }));
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}
async function chunk(id: string, offset: number, bytes: Uint8Array) {
  const response = await handleBackendRequest(new Request(`https://one21eight.test/api/v1/admin/uploads/banner-video/sessions/${id}/chunk?offset=${offset}`, { method: 'PUT', headers: { ...headersOf(), 'content-type': 'application/octet-stream' }, body: bytes as BodyInit }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}
const startSession = (name: string, size: number) => call('POST', '/admin/uploads/banner-video/sessions', { name, size });
/** The browser's loop: send every chunk in order, then complete. */
async function uploadAll(name: string, bytes: Uint8Array) {
  const s = await startSession(name, bytes.byteLength);
  const id = s.body.uploadId as string; const size = s.body.chunkBytes as number;
  for (let offset = s.body.received as number; offset < bytes.byteLength; offset += size) expect((await chunk(id, offset, bytes.slice(offset, offset + size))).status).toBe(200);
  return { id, done: await call('POST', `/admin/uploads/banner-video/sessions/${id}/complete`) };
}

describe('optimisation modes', () => {
  it('two uploads of the same file at once are separate sessions when each has its own key (and still resume with the same key)', async () => {
    const start = (key?: string) => call('POST', '/admin/uploads/banner-video/sessions', { name: 'same.mp4', size: 5 * MiB, mode: 'balanced', key });
    const [a, b] = [await start('k1'), await start('k2')];
    expect(a.body.uploadId).not.toBe(b.body.uploadId);
    expect((await start('k1')).body.uploadId).toBe(a.body.uploadId);
  });
  it('the chosen mode travels from the session to the processor; an unknown mode is rejected', async () => {
    for (const mode of ['balanced', 'small', 'original'] as const) {
      const s = await call('POST', '/admin/uploads/banner-video/sessions', { name: `${mode}.mov`, size: 5 * MiB, mode });
      expect(s.status).toBe(201); expect(s.body.mode).toBe(mode);
      await chunk(s.body.uploadId, 0, big(5));
      const done = await call('POST', `/admin/uploads/banner-video/sessions/${s.body.uploadId}/complete`);
      const job = await finished(done.body.jobId);
      expect(job.status).toBe('ready'); expect(job.mode).toBe(mode); expect(h.lastMode).toBe(mode);
    }
    expect((await call('POST', '/admin/uploads/banner-video/sessions', { name: 'x.mov', size: 5 * MiB, mode: 'ultra' })).status).toBe(422);
    const dflt = await call('POST', '/admin/uploads/banner-video/sessions', { name: 'd.mov', size: 5 * MiB });
    expect(dflt.body.mode).toBe('original');
  });
  it('a preserved original and a re-wrapped file report what really happened (no resize claim)', async () => {
    for (const action of ['preserved', 'remuxed'] as const) {
      h.convert = output(9 * MiB, action);
      const job = await finished((await uploadAll(`${action}.mp4`, big(9))).done.body.jobId);
      expect(job.info).toMatchObject({ action, resized: false, reencoded: false });
      expect(job.converted).toBe(action !== 'preserved');
      expect(job.warnings).toEqual([]);
    }
  });
  it('a failed or incomplete conversion is never reported as ready and stores nothing (the published banner video is untouched)', async () => {
    h.convert = async () => { throw new VideoError('output_too_large', 'Converting this video at original quality would make a 150.0 MB file, above this server\'s 100.0 MB limit for banner videos.'); };
    const job = await finished((await uploadAll('huge.mov', big(30))).done.body.jobId);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'output_too_large' } });
    expect(job.url).toBeUndefined(); expect(fake().storage['banner-media'].size).toBe(0);
  });
});

describe('chunked uploads: any size, resumable, safe', () => {
  it('uploads a 50 MB MOV in 8 MB chunks, converts it, and ends with a ready file; the temp files are gone', async () => {
    const { done } = await uploadAll('clip.mov', big(50));
    expect(done.status).toBe(202);
    expect(done.body).toMatchObject({ originalBytes: 50 * MiB, originalName: 'clip.mov' });
    const job = await finished(done.body.jobId);
    expect(job).toMatchObject({ status: 'ready', originalBytes: 50 * MiB });
    expect(job.processedBytes).toBeLessThanOrEqual(FINAL_MAX_BYTES); // the configurable output safeguard, not a quality target
    expect(fake().storage['banner-media'].size).toBe(1);
    await vi.waitFor(async () => expect(await leftovers()).toBeLessThanOrEqual(1)); // only the empty "uploads" folder may remain
  });
  it('a 100 MB original goes through in 13 chunks and is queued for conversion', async () => {
    const { done } = await uploadAll('hundred.mov', big(100));
    expect(done.status).toBe(202);
    expect((await finished(done.body.jobId)).status).toBe('ready');
  });
  it('accepts declared sizes far beyond the old limits (5 GB) because there is no cap, only free disk space', async () => {
    const r = await startSession('movie.mkv', 5 * 1024 * MiB);
    expect(r.status).toBe(201);
    expect(r.body.chunkBytes).toBe(8 * MiB);
    await call('DELETE', `/admin/uploads/banner-video/sessions/${r.body.uploadId}`);
  });
  it('refuses, with the real numbers, only when the disk cannot hold the video', async () => {
    h.freeBytes = 2 * 1024 * MiB;
    const r = await startSession('big.mov', 3 * 1024 * MiB);
    expect(r.status).toBe(507);
    expect(r.body.error.code).toBe('insufficient_storage');
    expect(r.body.error.message).toMatch(/free disk space/);
    expect(r.body.error.message).not.toMatch(/12 MB|MP4|WebM/);
  });
  it('an operator may add a cap (HERO_VIDEO_MAX_SOURCE_MB); unset means none, and the message names the setting', async () => {
    process.env.HERO_VIDEO_MAX_SOURCE_MB = '100';
    const r = await startSession('big.mov', 150 * MiB);
    expect(r.status).toBe(413);
    expect(r.body.error.message).toContain('HERO_VIDEO_MAX_SOURCE_MB');
    delete process.env.HERO_VIDEO_MAX_SOURCE_MB;
  });
  it('resumes after an interruption: the server reports how much it has and the upload continues from there', async () => {
    const bytes = big(20); const s = await startSession('r.mov', bytes.byteLength);
    const id = s.body.uploadId; const size = s.body.chunkBytes;
    await chunk(id, 0, bytes.slice(0, size));
    const again = await startSession('r.mov', bytes.byteLength); // same file again: the same session, with its progress
    expect(again.body.uploadId).toBe(id); expect(again.body.received).toBe(size);
    expect((await call('GET', `/admin/uploads/banner-video/sessions/${id}`)).body.received).toBe(size);
    for (let offset = size; offset < bytes.byteLength; offset += size) await chunk(id, offset, bytes.slice(offset, offset + size));
    expect((await call('POST', `/admin/uploads/banner-video/sessions/${id}/complete`)).status).toBe(202);
  });
  it('a repeated chunk is harmless, and a chunk at the wrong position is refused with the position to continue from', async () => {
    const bytes = big(20); const s = await startSession('o.mov', bytes.byteLength); const id = s.body.uploadId; const size = s.body.chunkBytes;
    await chunk(id, 0, bytes.slice(0, size));
    expect((await chunk(id, 0, bytes.slice(0, size))).body.received).toBe(size); // retry: acknowledged, not written twice
    const bad = await chunk(id, size + 1024, bytes.slice(0, 1024));
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('offset_mismatch');
    expect(bad.body.error.fieldErrors.received[0]).toBe(String(size));
  });
  it('cannot be completed early, and cannot send more than it declared', async () => {
    const s = await startSession('e.mov', 10 * MiB); const id = s.body.uploadId;
    await chunk(id, 0, big(4));
    const early = await call('POST', `/admin/uploads/banner-video/sessions/${id}/complete`);
    expect(early.status).toBe(409); expect(early.body.error.code).toBe('incomplete_upload');
    expect((await chunk(id, 4 * MiB, big(7))).status).toBe(422);
  });
  it('another admin cannot see, feed or complete someone else\'s upload', async () => {
    const s = await startSession('p.mov', 10 * MiB); const id = s.body.uploadId;
    h.adminId = 'someone-else';
    expect((await call('GET', `/admin/uploads/banner-video/sessions/${id}`)).status).toBe(404);
    expect((await chunk(id, 0, big(1))).status).toBe(404);
    expect((await call('POST', `/admin/uploads/banner-video/sessions/${id}/complete`)).status).toBe(404);
  });
  it('cancelling deletes the partial file; too many simultaneous large uploads are told to wait', async () => {
    const first = await startSession('a.mov', 10 * MiB);
    await chunk(first.body.uploadId, 0, big(2));
    expect(await leftovers()).toBeGreaterThan(0);
    await call('DELETE', `/admin/uploads/banner-video/sessions/${first.body.uploadId}`);
    expect((await call('GET', `/admin/uploads/banner-video/sessions/${first.body.uploadId}`)).status).toBe(404);
    for (const n of [1, 2, 3]) expect((await startSession(`f${n}.mov`, 10 * MiB)).status).toBe(201);
    const busy = await startSession('f4.mov', 10 * MiB);
    expect(busy.status).toBe(429); expect(busy.body.error.code).toBe('video_busy');
  });
  it('needs an admin, and an empty file is refused', async () => {
    expect((await startSession('z.mov', 0)).status).toBe(422);
    h.role = null;
    expect((await startSession('z.mov', 5 * MiB)).status).toBe(401);
  });
});
void json;

describe('upload lifecycle: nothing can hold the queue for ever', () => {
  const storagePost = (init?: RequestInit) => init?.method === 'POST';
  /** Storage that never answers and never moves a byte, but honours cancellation like a real connection. */
  const hangingStorage = () => vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (storagePost(init)) return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); });
    return Promise.resolve(new Response(null, { status: 200 }));
  });

  it('a hung Storage upload does NOT hold the encoder: the next video is processed meanwhile, then the hung one fails with a clear message and nothing is stored', async () => {
    process.env.HERO_VIDEO_UPLOAD_IDLE_S = '5';
    try {
      hangingStorage();
      h.convert = output(4 * MiB);
      const a = await uploadAll('first.mov', big(5));
      await vi.waitFor(async () => expect((await getJob(a.done.body.jobId)).body.stage).toBe('uploading'), { timeout: 20_000 });
      // job B arrives while A is stuck sending: it must start (processing finishes) instead of "waiting for other videos" for ever
      const b = await uploadAll('second.mov', big(6));
      await vi.waitFor(async () => { const job = (await getJob(b.done.body.jobId)).body; expect(job.stage).toBe('uploading'); }, { timeout: 20_000 });
      const failedA = await finished(a.done.body.jobId);
      expect(failedA).toMatchObject({ status: 'failed', error: { code: 'storage_timeout' } });
      expect(failedA.error.message).toMatch(/stopped making progress/); expect(failedA.error.message).toMatch(/published video was not changed/i);
      const failedB = await finished(b.done.body.jobId);
      expect(failedB.status).toBe('failed');
      expect(fake().storage['banner-media'].size).toBe(0);
      await vi.waitFor(async () => expect(await jobFolders()).toBe(0)); // temp files of both jobs are gone
      // the queue is free again: a third upload works without any refresh or restart
      vi.restoreAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        if (storagePost(init)) { const r = (init!.body as ReadableStream<Uint8Array>).getReader(); for (;;) { const { done } = await r.read(); if (done) break; } return Response.json({ Key: 'ok' }); }
        return new Response(null, { status: 200 });
      });
      const c = await uploadAll('third.mov', big(7));
      expect((await finished(c.done.body.jobId)).status).toBe('ready');
    } finally { delete process.env.HERO_VIDEO_UPLOAD_IDLE_S; }
  }, 90_000);

  it('a queued video reports how many videos are ahead of it (a real position, not an open-ended wait)', async () => {
    let release!: () => void;
    h.convert = async outDir => { await new Promise<void>(resolve => { release = resolve; }); return output(4 * MiB)(outDir); };
    const first = await uploadAll('one.mov', big(5));
    await vi.waitFor(async () => expect((await getJob(first.done.body.jobId)).body.status).toBe('processing'));
    h.convert = output(4 * MiB);
    const second = await uploadAll('two.mov', big(6));
    const queued = (await getJob(second.done.body.jobId)).body;
    expect(queued).toMatchObject({ status: 'queued', ahead: 1 });
    release();
    expect((await finished(first.done.body.jobId)).status).toBe('ready');
    expect((await finished(second.done.body.jobId)).status).toBe('ready');
  });

  it('a job that stops reporting progress is failed by the watchdog and frees its slot; the next video then runs', async () => {
    h.convert = () => new Promise(() => undefined); // an encoder that never answers
    const stuck = await uploadAll('stuck.mov', big(5));
    await vi.waitFor(async () => expect((await getJob(stuck.done.body.jobId)).body.status).toBe('processing'));
    const real = Date.now; const base = real();
    vi.spyOn(Date, 'now').mockImplementation(() => base + 3 * 3_600_000 + (real() - base));
    const reaped = (await getJob(stuck.done.body.jobId)).body;
    expect(reaped).toMatchObject({ status: 'failed', error: { code: 'stalled' } });
    expect(reaped.error.message).toMatch(/published video was not changed/i);
    h.convert = output(4 * MiB);
    const next = await uploadAll('next.mov', big(6));
    expect((await finished(next.done.body.jobId)).status).toBe('ready'); // the slot was released
  });

  it('failures at every step end as "failed" and release the queue: encoder error, storage refusal, unreadable file', async () => {
    for (const make of [
      () => { h.convert = async () => { throw new VideoError('encode_failed', 'FFmpeg could not convert this video.'); }; },
      () => { h.convert = output(4 * MiB); (fake() as FakeHeroDb & { uploadFailure: unknown }).uploadFailure = { message: 'storage down', status: 503 }; },
      () => { h.convert = async () => { throw new VideoError('unreadable', 'This file could not be read as a video.'); }; (fake() as FakeHeroDb & { uploadFailure: unknown }).uploadFailure = null; },
    ]) {
      make();
      const job = await finished((await uploadAll(`fail-${Math.random()}.mov`, big(5))).done.body.jobId);
      expect(job.status).toBe('failed'); expect(job.error.message.length).toBeGreaterThan(10);
    }
    (fake() as FakeHeroDb & { uploadFailure: unknown }).uploadFailure = null; h.convert = output(4 * MiB);
    expect((await finished((await uploadAll('after.mov', big(5))).done.body.jobId)).status).toBe('ready');
    expect(fake().storage['banner-media'].size).toBe(1); await vi.waitFor(async () => expect(await jobFolders()).toBe(0));
  });

  it('desktop and mobile uploads are separate on the browser side (one state per uploader) and share only the server queue, one video at a time', () => {
    const src = readFileSync('components/admin/hero-video-uploader.tsx', 'utf8');
    expect(src).toContain('const uploading = useRef(false)'); // per component instance: a desktop upload never blocks the mobile slot's own state
    expect(src).toContain('Waiting in line');
    expect(src).toContain('Uploading processed video to storage');
    expect(src).toContain('Try again');
  });
});
