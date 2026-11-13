import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OptimizeMode } from '@/lib/video-plan';
import { probeVideo, processVideo, spawnRunner } from '@/lib/backend/video-transcode';

/**
 * REAL FFmpeg round trips for the three optimisation modes. Skipped unless FFMPEG_PATH and FFPROBE_PATH point at working binaries:
 *
 *   FFMPEG_PATH=ffmpeg FFPROBE_PATH=ffprobe npx vitest run tests/unit/video-ffmpeg.integration.test.ts
 *
 * "Preserved" and "re-wrapped" are not taken on trust: the file's video-stream packets are checksummed (ffmpeg -c copy -f md5) before and after,
 * and the size, resolution and frame rate are measured from the produced file.
 */
const FFMPEG = process.env.FFMPEG_PATH; const FFPROBE = process.env.FFPROBE_PATH;
const enabled = Boolean(FFMPEG && FFPROBE);
const MiB = 1024 * 1024;

describe.skipIf(!enabled)('FFmpeg end to end: Original / Balanced / Smaller Size', () => {
  let dir = '';
  // These tests exercise conversion quality on deliberately heavy synthetic clips, not the output limit (the 45,000,000-byte boundary has its own tests).
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'o218-ff-')); process.env.HERO_VIDEO_MAX_OUTPUT_MB = '100'; }, 30_000);
  afterAll(async () => { delete process.env.HERO_VIDEO_MAX_OUTPUT_MB; if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  const make = (name: string, args: string[], seconds: number, size: string, rate = 30, noise = 35) => {
    const file = path.join(dir, name);
    execFileSync(FFMPEG!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}`, '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', String(seconds), '-vf', `noise=alls=${noise}:allf=t`, ...args, file], { timeout: 280_000 });
    return file;
  };
  const h264 = (mbps: number, extra: string[] = []) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', `${mbps}M`, '-minrate', `${mbps}M`, '-maxrate', `${mbps}M`, '-bufsize', `${mbps * 2}M`, '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra];
  /** Checksum of the VIDEO packets exactly as stored (stream copy): equal checksums mean the video stream was not touched. */
  const videoMd5 = (file: string) => execFileSync(FFMPEG!, ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();
  const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
  const decodes = (file: string) => execFileSync(FFMPEG!, ['-v', 'error', '-i', file, '-f', 'null', '-'], { timeout: 180_000 });
  const run = async (file: string, mode: OptimizeMode, opts: { maxOutputBytes?: number } = {}) => {
    const out = await mkdtemp(path.join(dir, 'out-'));
    const source = await probeVideo(file, spawnRunner, 60_000);
    const result = await processVideo(file, out, { mode, ...opts });
    const probe = await probeVideo(result.path, spawnRunner, 60_000);
    decodes(result.path);
    return { source, result, probe, bytes: (await stat(result.path)).size };
  };
  const sizeNote = (label: string, r: { source: { sizeBytes: number }; bytes: number; probe: { width: number; height: number; fps: number } }) => console.info(`[real] ${label}: ${(r.source.sizeBytes / MiB).toFixed(1)} MB -> ${(r.bytes / MiB).toFixed(2)} MB ${r.probe.width}x${r.probe.height}@${Math.round(r.probe.fps)}`);

  describe('Original Quality (default)', () => {
    it('a small compatible MP4 (index up front) is kept byte for byte: same file, same checksum, no re-encode', async () => {
      const file = make('small.mp4', h264(3, ['-movflags', '+faststart']), 5, '1280x720');
      const before = await sha(file);
      const r = await run(file, 'original');
      expect(r.result.info).toMatchObject({ action: 'preserved', preserved: true, reencoded: false, resized: false });
      expect(r.result.path).toBe(file); expect(await sha(r.result.path)).toBe(before); expect(r.bytes).toBe(r.source.sizeBytes);
      expect(r.probe).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264' });
    });
    it('a small MOV (QuickTime) is re-wrapped to MP4 with a stream copy: the video stream is bit-for-bit identical', async () => {
      const file = make('small.mov', h264(4), 6, '1280x720');
      expect((await probeVideo(file, spawnRunner, 60_000)).brand).toBe('qt  ');
      const r = await run(file, 'original');
      expect(r.result.info).toMatchObject({ action: 'remuxed', remuxed: true, reencoded: false, resized: false });
      expect(r.result.ext).toBe('mp4'); expect(videoMd5(r.result.path)).toBe(videoMd5(file));
      expect(r.probe).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264', audioCodec: 'aac' }); expect(Math.round(r.probe.fps)).toBe(30);
      expect(Math.abs(r.bytes - r.source.sizeBytes) / r.source.sizeBytes).toBeLessThan(0.02);
      sizeNote('small MOV, original', r);
    }, 120_000);
    it('a LARGE MOV (~40 MB, 1080p) keeps its size, resolution, frame rate and every video packet; nothing is compressed', async () => {
      const file = make('large.mov', h264(32), 10, '1920x1080');
      const r = await run(file, 'original');
      expect(r.source.sizeBytes).toBeGreaterThan(30 * MiB);
      expect(r.result.info).toMatchObject({ action: 'remuxed', resized: false, reencoded: false });
      expect(videoMd5(r.result.path)).toBe(videoMd5(file));
      expect(r.probe).toMatchObject({ width: 1920, height: 1080 }); expect(r.bytes).toBeGreaterThan(30 * MiB);
      sizeNote('large MOV, original', r);
    }, 300_000);
    it('a LARGE 4K file stays 4K: not resized, not recompressed', async () => {
      const file = make('4k.mp4', h264(30), 6, '3840x2160', 30, 25);
      const r = await run(file, 'original');
      expect(r.result.info).toMatchObject({ resized: false, reencoded: false }); expect(r.probe).toMatchObject({ width: 3840, height: 2160 });
      expect(videoMd5(r.result.path)).toBe(videoMd5(file)); expect(r.bytes).toBeGreaterThan(r.source.sizeBytes * 0.97);
      expect(r.result.warnings.join(' ')).not.toMatch(/1080p|Resolution reduced/);
      sizeNote('4K, original', r);
    }, 400_000);
    it('a compatible VP9 WebM is kept as a WebM', async () => {
      const file = make('keep.webm', ['-c:v', 'libvpx-vp9', '-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'], 5, '1280x720');
      const r = await run(file, 'original');
      expect(r.result.ext).toBe('webm'); expect(r.probe.videoCodec).toBe('vp9'); expect(r.result.info.reencoded).toBe(false);
      expect(videoMd5(r.result.path)).toBe(videoMd5(file));
    }, 120_000);
    it('only a codec browsers cannot play is converted (iPhone-style 10-bit HEVC MOV): H.264, 8-bit, SAME resolution and frame rate, with a quality note', async () => {
      const file = make('iphone.mov', ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-b:v', '20M', '-x265-params', 'log-level=error', '-c:a', 'aac'], 8, '1920x1080');
      const r = await run(file, 'original');
      expect(r.source.videoCodec).toBe('hevc');
      expect(r.result.info).toMatchObject({ action: 'reencoded', reencoded: true, resized: false });
      expect(r.probe).toMatchObject({ videoCodec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080 }); expect(Math.round(r.probe.fps)).toBe(30);
      expect(r.result.warnings.join(' ')).toMatch(/Converted for browser playback because/);
      expect(r.bytes).toBeLessThan(r.source.sizeBytes * 2.4); // bounded: a near-lossless conversion must not balloon
      sizeNote('HEVC 10-bit, original', r);
    }, 300_000);
    it('an AVI (MPEG-4) is converted at its own resolution', async () => {
      const r = await run(make('clip.avi', ['-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'mp3'], 6, '1280x720'), 'original');
      expect(r.result.info).toMatchObject({ action: 'reencoded', resized: false }); expect(r.probe).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264' });
    }, 180_000);
    it('refuses (does not degrade) when the result would exceed the configured safeguard', async () => {
      await expect(run(make('limit.mov', h264(20), 6, '1920x1080'), 'original', { maxOutputBytes: 5 * MiB })).rejects.toMatchObject({ code: 'output_too_large' });
    }, 180_000);
  });

  describe('Auto Compress — Balanced', () => {
    it('re-encodes a large 1080p file smaller at the SAME resolution and frame rate, and says nothing about 1080p scaling', async () => {
      const file = make('large2.mov', h264(32), 10, '1920x1080');
      const r = await run(file, 'balanced');
      expect(r.result.info).toMatchObject({ mode: 'balanced', action: 'reencoded', resized: false });
      expect(r.probe).toMatchObject({ width: 1920, height: 1080 }); expect(Math.round(r.probe.fps)).toBe(30);
      expect(r.bytes).toBeLessThan(r.source.sizeBytes * 0.9); expect(r.result.warnings.join(' ')).not.toMatch(/1080p|scaled down|Resolution reduced/);
      sizeNote('large 1080p, balanced', r);
    }, 400_000);
    it('keeps a 4K file at 4K and 60 fps (not resized, not frame-dropped) while making it smaller', async () => {
      const file = make('4k60.mp4', h264(40), 5, '3840x2160', 60, 25);
      const r = await run(file, 'balanced');
      expect(r.probe).toMatchObject({ width: 3840, height: 2160 }); expect(Math.round(r.probe.fps)).toBe(60); expect(r.result.info.resized).toBe(false);
      expect(r.bytes).toBeLessThanOrEqual(r.source.sizeBytes); sizeNote('4K 60, balanced', r);
    }, 500_000);
    it('keeps the ORIGINAL when it is already efficient (compressing would not help)', async () => {
      const file = make('efficient.mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac'], 6, '1280x720', 30, 5);
      const r = await run(file, 'balanced');
      expect(['preserved', 'remuxed', 'reencoded']).toContain(r.result.info.action);
      expect(r.bytes).toBeLessThanOrEqual(r.source.sizeBytes);
      if (r.result.info.action !== 'reencoded') expect(r.result.warnings.join(' ')).toMatch(/would not make this file meaningfully smaller/);
      sizeNote(`efficient, balanced (${r.result.info.action})`, r);
    }, 200_000);
    it('REAL fit fallback: above the configured safeguard it compresses further, reducing resolution only as needed, and reports it', async () => {
      const file = make('toobig.mp4', h264(30), 10, '1920x1080');
      const r = await run(file, 'balanced', { maxOutputBytes: 8 * MiB });
      expect(r.bytes).toBeLessThanOrEqual(8 * MiB); expect(r.result.info.summary).toMatch(/Compressed to fit this server's/); expect(r.result.info.attempts).toBeGreaterThanOrEqual(2);
      sizeNote('forced fit, balanced', r);
    }, 400_000);
  });

  describe('Auto Compress — Smaller Size', () => {
    it('is smaller than Balanced for the same file; a 4K 60 fps source becomes 1080p / 30 fps and the admin is told exactly that', async () => {
      const file = make('4k60b.mp4', h264(40), 5, '3840x2160', 60, 25);
      const balanced = await run(file, 'balanced'); const small = await run(file, 'small');
      expect(small.bytes).toBeLessThan(balanced.bytes);
      expect(small.probe.height).toBeLessThanOrEqual(1080); expect(Math.round(small.probe.fps)).toBe(30); expect(small.result.info.resized).toBe(true);
      expect(small.result.warnings.join(' ')).toMatch(/Resolution reduced from 3840×2160 to 1920×1080/); expect(small.result.warnings.join(' ')).toMatch(/Frame rate reduced from 60 to 30/);
      expect(Math.abs(small.probe.width / small.probe.height - 16 / 9)).toBeLessThan(0.02);
      sizeNote('4K 60, small', small);
    }, 600_000);
    it('never upscales: a 720p source stays 720p, a portrait source stays portrait', async () => {
      const a = await run(make('p720.mp4', h264(8), 5, '1280x720'), 'small'); expect(a.probe).toMatchObject({ width: 1280, height: 720 }); expect(a.result.info.resized).toBe(false);
      const b = await run(make('portrait.mp4', h264(10), 5, '1080x1920'), 'small'); expect(b.probe.width / b.probe.height).toBeCloseTo(1080 / 1920, 1);
    }, 300_000);
  });

  describe('high motion, failures', () => {
    it('high-motion video (heavy noise, 60 fps): Balanced keeps 60 fps and stays valid; Smaller Size is smaller at 30 fps', async () => {
      const file = make('motion.mp4', h264(24), 8, '1920x1080', 60, 60);
      const balanced = await run(file, 'balanced'); const small = await run(file, 'small');
      expect(Math.round(balanced.probe.fps)).toBe(60); expect(Math.round(small.probe.fps)).toBe(30); expect(small.bytes).toBeLessThan(balanced.bytes);
      console.info(`[real] high motion: source ${(balanced.source.sizeBytes / MiB).toFixed(1)} MB, balanced ${(balanced.bytes / MiB).toFixed(1)} MB, small ${(small.bytes / MiB).toFixed(1)} MB; small notes: ${small.result.warnings.join(' | ') || 'none'}`);
    }, 600_000);
    it('corrupt, text-as-video and audio-only inputs are refused with clear messages in every mode', async () => {
      const corrupt = path.join(dir, 'corrupt.mov'); await writeFile(corrupt, Buffer.alloc(3 * MiB, 7));
      const text = path.join(dir, 'text.mov'); await writeFile(text, 'definitely not a video '.repeat(2000));
      const audio = path.join(dir, 'audio.mov'); execFileSync(FFMPEG!, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-f', 'ipod', audio]);
      for (const mode of ['original', 'balanced', 'small'] as const) {
        for (const f of [corrupt, text]) await expect(processVideo(f, await mkdtemp(path.join(dir, 'bad-')), { mode })).rejects.toMatchObject({ code: 'unreadable' });
        await expect(processVideo(audio, await mkdtemp(path.join(dir, 'bad-')), { mode })).rejects.toMatchObject({ code: 'no_video' });
      }
    }, 120_000);
    it('a clip longer than the configurable duration safeguard is refused with the setting named', async () => {
      const file = make('long.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40', '-c:a', 'aac'], 320, '320x180');
      await expect(processVideo(file, await mkdtemp(path.join(dir, 'long-')), { mode: 'original' })).rejects.toMatchObject({ code: 'too_long', message: expect.stringContaining('HERO_VIDEO_MAX_DURATION_S') });
    }, 300_000);
  });
});
