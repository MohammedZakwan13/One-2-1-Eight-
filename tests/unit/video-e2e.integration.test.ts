/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed API JSON in test helpers */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHeroDb } from './helpers/fake-hero-db';

/**
 * REAL end to end through the production routes: chunked sessions, the queue, the background worker and FFmpeg/FFprobe, driven over the backend
 * dispatcher exactly as the admin screen drives them, in each optimisation mode. Only storage and auth are stand-ins (the bytes that WOULD be stored
 * are captured, written to disk, probed and decoded). Skipped unless FFmpeg is available:
 *
 *   FFMPEG_PATH=ffmpeg FFPROBE_PATH=ffprobe npx vitest run tests/unit/video-e2e.integration.test.ts
 */
const FFMPEG = process.env.FFMPEG_PATH; const FFPROBE = process.env.FFPROBE_PATH;
const enabled = Boolean(FFMPEG && FFPROBE);
const MiB = 1024 * 1024;

const h = vi.hoisted(() => ({
  db: null as unknown,
  stored: [] as { bytes: Uint8Array; ext: string }[],
  env: { siteUrl: 'https://one21eight.test', apiMode: 'supabase', supabase: { url: 'https://p.supabase.co', serviceRoleKey: 'k', anonKey: 'a' }, adminSessionCookie: 's', razorpay: null, emailProvider: 'resend' },
}));
vi.mock('@/lib/env', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/env')>()), getServerEnv: () => h.env }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.db }));
vi.mock('@/lib/backend/auth', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/backend/auth')>()), requireAdmin: async () => ({ id: 'a1', email: 'a@b.co', name: 'A', role: 'owner' }) }));
vi.mock('@/lib/backend/banner-storage', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/backend/banner-storage')>();
  const record = (bytes: Uint8Array, ext: string) => { h.stored.push({ bytes, ext }); const path = `banners/2026/11/${h.stored.length}.${ext}`; return { path, url: `https://p.supabase.co/storage/v1/object/public/banner-media/${path}` }; };
  return {
    ...real,
    storeBannerVideo: async (bytes: Uint8Array, ext: string) => record(bytes, ext),
    // The converter's file is checked with the REAL final-format guard (MP4/WebM only, never a MOV) before it would be uploaded.
    storeBannerVideoFile: async (file: string, _size: number, ext: string, mime: string) => { const bytes = new Uint8Array(await readFile(file)); real.assertFinalFormat(ext, mime, bytes.subarray(0, 16)); return record(bytes, ext); },
  };
});
import { handleBackendRequest } from '@/lib/backend';
import { probeVideo, spawnRunner } from '@/lib/backend/video-transcode';
import { resetVideoJobsForTests } from '@/lib/backend/video-jobs';
import { resetUploadSessionsForTests } from '@/lib/backend/video-uploads';

const CSRF = 'csrf-token';
const hdr = () => ({ 'x-csrf-token': CSRF, cookie: `o218_csrf=${CSRF}; s=session` });
async function api(method: string, p: string, body?: unknown, raw?: Uint8Array) {
  const init: RequestInit = raw ? { method, headers: { ...hdr(), 'content-type': 'application/octet-stream' }, body: raw as BodyInit } : { method, headers: body === undefined ? hdr() : { ...hdr(), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
  const response = await handleBackendRequest(new Request(`https://one21eight.test/api/v1${p}`, init));
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

describe.skipIf(!enabled)('banner video upload with REAL FFmpeg, in all three modes', () => {
  let dir = '';
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'o218-e2e-')); process.env.HERO_VIDEO_TMP_DIR = path.join(dir, 'work'); }, 30_000);
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  beforeEach(() => { h.db = createFakeHeroDb(); h.stored.length = 0; delete (globalThis as Record<string, unknown>).__o218_supabase__; resetVideoJobsForTests(); resetUploadSessionsForTests(); });

  const make = (name: string, args: string[], seconds: number, size: string, rate = 30, noise = 35) => {
    const file = path.join(dir, name);
    execFileSync(FFMPEG!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', String(seconds), '-vf', `noise=alls=${noise}:allf=t`, ...args, file], { timeout: 280_000 });
    return file;
  };
  const h264 = (mbps: number) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${mbps}M`, '-minrate', `${mbps}M`, '-maxrate', `${mbps}M`, '-bufsize', `${mbps * 2}M`, '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  const videoMd5 = (file: string) => execFileSync(FFMPEG!, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();

  /** Exactly the browser's loop: start a session (with the mode), send every chunk in order, complete, then poll the job. */
  async function upload(file: string, mode: 'original' | 'balanced' | 'small') {
    const bytes = new Uint8Array(await readFile(file));
    const s = await api('POST', '/admin/uploads/banner-video/sessions', { name: path.basename(file), size: bytes.byteLength, mode });
    expect(s.status).toBe(201); expect(s.body.mode).toBe(mode);
    for (let offset = 0; offset < bytes.byteLength; offset += s.body.chunkBytes) expect((await api('PUT', `/admin/uploads/banner-video/sessions/${s.body.uploadId}/chunk?offset=${offset}`, undefined, bytes.slice(offset, offset + s.body.chunkBytes))).status).toBe(200);
    const done = await api('POST', `/admin/uploads/banner-video/sessions/${s.body.uploadId}/complete`);
    expect(done.status).toBe(202);
    return { size: bytes.byteLength, jobId: done.body.jobId as string };
  }
  async function finish(jobId: string) {
    let job: Record<string, any> = {};
    await vi.waitFor(async () => { job = (await api('GET', `/admin/uploads/banner-video/jobs/${jobId}`)).body; expect(['ready', 'failed']).toContain(job.status); }, { timeout: 900_000, interval: 500 });
    return job;
  }
  /** Writes what would be stored to disk and measures it. */
  async function stored(index: number) {
    const s = h.stored[index]; const out = path.join(dir, `stored-${index}-${Math.random().toString(36).slice(2)}.${s.ext}`);
    await writeFile(out, s.bytes);
    execFileSync(FFMPEG!, ['-v', 'error', '-i', out, '-f', 'null', '-'], { timeout: 180_000 }); // plays through without a decode error
    return { out, bytes: s.bytes.byteLength, probe: await probeVideo(out, spawnRunner, 60_000) };
  }

  it('ORIGINAL QUALITY: a large MOV is stored with every video packet unchanged, at its size, resolution and frame rate (verified by checksum)', async () => {
    const file = make('large.mov', h264(32), 10, '1920x1080');
    const { size, jobId } = await upload(file, 'original');
    const job = await finish(jobId);
    expect(job.status, job.error?.message).toBe('ready');
    expect(job.info).toMatchObject({ mode: 'original', action: 'remuxed', resized: false, reencoded: false });
    const s = await stored(0);
    expect(videoMd5(s.out)).toBe(videoMd5(file));
    expect(s.probe).toMatchObject({ width: 1920, height: 1080, videoCodec: 'h264' }); expect(Math.round(s.probe.fps)).toBe(30);
    expect(Math.abs(s.bytes - size) / size).toBeLessThan(0.02);
    expect(job.warnings).toEqual([]);
    console.info(`[real e2e] original: ${(size / MiB).toFixed(1)} MB MOV -> ${(s.bytes / MiB).toFixed(1)} MB MP4, took ${job.processingMs} ms`);
  }, 900_000);

  it('a small compatible MP4 in Original Quality is stored byte for byte', async () => {
    const file = make('small.mp4', [...h264(3), '-movflags', '+faststart'], 5, '1280x720');
    const original = new Uint8Array(await readFile(file));
    const job = await finish((await upload(file, 'original')).jobId);
    expect(job).toMatchObject({ status: 'ready', converted: false }); expect(job.info.action).toBe('preserved');
    expect(Buffer.from(h.stored[0].bytes).equals(Buffer.from(original))).toBe(true);
  }, 300_000);

  it('BALANCED: a 4K file stays 4K (not resized) and is smaller; the report does not claim 1080p', async () => {
    const file = make('4k.mp4', h264(36), 5, '3840x2160', 30, 25);
    const { size, jobId } = await upload(file, 'balanced');
    const job = await finish(jobId);
    expect(job.status, job.error?.message).toBe('ready'); expect(job.info).toMatchObject({ mode: 'balanced', action: 'reencoded', resized: false });
    const s = await stored(0);
    expect(s.probe).toMatchObject({ width: 3840, height: 2160 }); expect(s.bytes).toBeLessThan(size);
    expect(JSON.stringify(job)).not.toMatch(/1080p|scaled down|Resolution reduced/);
    console.info(`[real e2e] balanced 4K: ${(size / MiB).toFixed(1)} MB -> ${(s.bytes / MiB).toFixed(1)} MB, took ${job.processingMs} ms`);
  }, 900_000);

  it('SMALLER SIZE: a 4K 60 fps file becomes 1080p / 30 fps, smaller than Balanced would make it, and the report says exactly that', async () => {
    const file = make('4k60.mp4', h264(40), 5, '3840x2160', 60, 25);
    const { size, jobId } = await upload(file, 'small');
    const job = await finish(jobId);
    expect(job.status, job.error?.message).toBe('ready'); expect(job.info).toMatchObject({ mode: 'small', resized: true });
    const s = await stored(0);
    expect(s.probe.height).toBeLessThanOrEqual(1080); expect(Math.round(s.probe.fps)).toBe(30); expect(s.bytes).toBeLessThan(size * 0.5);
    expect(job.warnings.join(' ')).toMatch(/Resolution reduced from 3840×2160 to 1920×1080/);
    console.info(`[real e2e] small 4K60: ${(size / MiB).toFixed(1)} MB -> ${(s.bytes / MiB).toFixed(1)} MB ${s.probe.width}x${s.probe.height}, took ${job.processingMs} ms`);
  }, 900_000);

  it('HEVC iPhone-style clip in Original Quality: converted only because of the codec, same resolution, bounded size, with the quality note', async () => {
    const file = make('iphone.mov', ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-b:v', '20M', '-x265-params', 'log-level=error', '-c:a', 'aac'], 8, '1920x1080');
    // At the default 45,000,000-byte limit this near-lossless conversion (about 45.7 MB for this noisy clip) is refused honestly, and nothing is stored.
    const refused = await finish((await upload(file, 'original')).jobId);
    expect(refused).toMatchObject({ status: 'failed', error: { code: 'output_too_large' } }); expect(refused.error.message).toContain('45,000,000 bytes'); expect(h.stored).toHaveLength(0);
    // With a larger configured limit (HERO_VIDEO_MAX_OUTPUT_MB) the same clip converts: this part exercises the conversion, not the limit.
    process.env.HERO_VIDEO_MAX_OUTPUT_MB = '100';
    const { size, jobId } = await upload(file, 'original');
    const job = await finish(jobId);
    delete process.env.HERO_VIDEO_MAX_OUTPUT_MB;
    expect(job.status, job.error?.message).toBe('ready'); expect(job.info).toMatchObject({ action: 'reencoded', resized: false });
    const s = await stored(0);
    expect(s.probe).toMatchObject({ videoCodec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080 }); expect(s.bytes).toBeLessThan(size * 2.4);
    expect(job.warnings.join(' ')).toMatch(/Converted for browser playback because/);
    console.info(`[real e2e] HEVC original: ${(size / MiB).toFixed(1)} MB -> ${(s.bytes / MiB).toFixed(1)} MB, took ${job.processingMs} ms`);
  }, 900_000);

  it('failures are explained in every mode and store nothing: corrupt file, text renamed .mov', async () => {
    const corrupt = path.join(dir, 'corrupt.mov'); await writeFile(corrupt, Buffer.alloc(3 * MiB, 7));
    const text = path.join(dir, 'text.mov'); await writeFile(text, 'definitely not a video '.repeat(2000));
    for (const mode of ['original', 'balanced', 'small'] as const) for (const f of [corrupt, text]) {
      const job = await finish((await upload(f, mode)).jobId);
      expect(job.status).toBe('failed'); expect(job.error.message.length).toBeGreaterThan(20); expect(job.error.message).not.toMatch(/12 MB or smaller|only MP4/i);
    }
    expect(h.stored).toHaveLength(0);
  }, 300_000);

  it('three uploads at once in three different modes are queued and all finish correctly; other requests are answered meanwhile', async () => {
    const files = [make('par1.mov', h264(14), 6, '1920x1080'), make('par2.mp4', h264(14), 6, '1920x1080'), make('par3.mp4', h264(14), 6, '1920x1080')];
    const modes = ['original', 'balanced', 'small'] as const;
    const jobs = await Promise.all(files.map((f, i) => upload(f, modes[i])));
    const started = Date.now();
    expect((await api('GET', '/admin/uploads/banner-video/jobs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect(Date.now() - started).toBeLessThan(2000); // the server keeps answering while videos are processed
    const done = await Promise.all(jobs.map(j => finish(j.jobId)));
    expect(done.every(j => j.status === 'ready')).toBe(true);
    expect(done.map(j => j.mode)).toEqual(['original', 'balanced', 'small']);
    expect(h.stored).toHaveLength(3);
  }, 1_200_000);
});
