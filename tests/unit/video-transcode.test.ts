import { mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserCompat, displaySize, ladderFor, nextBudget, parseProbe, planEncode, qualityNotes, qualityPlan, videoBitrate, DEFAULT_MAX_OUTPUT_BYTES, TARGET_BYTES, type OptimizeMode, type Probe } from '@/lib/video-plan';
import { VideoError, ffmpegAvailable, moovBeforeMdat, processVideo, qualityArgs, resetFfmpegAvailability, videoConfig, type Runner } from '@/lib/backend/video-transcode';

const MiB = 1024 * 1024;
type P = { w?: number; h?: number; dur?: number; v?: string; pix?: string; a?: string | null; fmt?: string; fps?: string; rotate?: number; brand?: string; transfer?: string };
const MP4_FMT = 'mov,mp4,m4a,3gp,3g2,mj2';
const probeJson = ({ w = 1920, h = 1080, dur = 8, v = 'h264', pix = 'yuv420p', a = 'aac', fmt = MP4_FMT, fps = '30/1', rotate = 0, brand = 'isom', transfer }: P = {}) => ({
  format: { format_name: fmt, duration: String(dur), tags: { major_brand: brand } },
  streams: [{ codec_type: 'video', codec_name: v, width: w, height: h, pix_fmt: pix, avg_frame_rate: fps, color_transfer: transfer, side_data_list: rotate ? [{ rotation: rotate }] : [] }, ...(a ? [{ codec_type: 'audio', codec_name: a }] : [])],
});
const base = (over: Partial<Probe> = {}): Probe => ({ duration: 8, width: 1920, height: 1080, fps: 30, videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac', formatNames: ['mov', 'mp4'], rotation: 0, sizeBytes: 5 * MiB, brand: 'isom', hdr: false, ...over });

describe('plan rules (pure)', () => {
  it('there is no fixed 12 MB output limit: the only default safeguard is configurable and larger', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(12 * MiB);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(45_000_000); // below the Supabase Free plan's 50,000,000-byte per-file limit
    expect(videoConfig().maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    process.env.HERO_VIDEO_MAX_OUTPUT_MB = '200'; expect(videoConfig().maxOutputBytes).toBe(200 * MiB); delete process.env.HERO_VIDEO_MAX_OUTPUT_MB; // configurable after an upgrade
    process.env.HERO_VIDEO_MAX_OUTPUT_MB = '40'; expect(videoConfig().maxOutputBytes).toBe(40 * MiB); delete process.env.HERO_VIDEO_MAX_OUTPUT_MB;
  });
  it('browserCompat judges real codecs, not names', () => {
    expect(browserCompat(base())).toEqual({ ok: true, container: 'mp4' });
    expect(browserCompat(base({ audioCodec: null }))).toMatchObject({ ok: true });
    expect(browserCompat(base({ formatNames: ['matroska', 'webm'], videoCodec: 'vp9', audioCodec: 'opus' }))).toEqual({ ok: true, container: 'webm' });
    for (const bad of [base({ videoCodec: 'hevc' }), base({ pixelFormat: 'yuv420p10le' }), base({ audioCodec: 'pcm_s16le' }), base({ fps: 120 }), base({ formatNames: ['avi'], videoCodec: 'mpeg4' }), base({ formatNames: ['matroska', 'webm'], videoCodec: 'h264' })]) expect(browserCompat(bad).ok).toBe(false);
  });
  it('qualityPlan: original never scales or limits fps; balanced keeps resolution (8K -> 4K only); small caps at 1080p / 30 fps; nothing upscales', () => {
    const k4 = base({ width: 3840, height: 2160, fps: 60, sizeBytes: 60 * MiB });
    expect(qualityPlan(k4, 'original')).toMatchObject({ crf: 17, maxHeight: null, maxFps: null });
    const srcBps = (60 * MiB * 8) / 8;
    expect(qualityPlan(base({ videoCodec: 'hevc', sizeBytes: 60 * MiB }), 'original').maxrateBps).toBe(Math.floor(srcBps * 2)); // HEVC -> H.264 may need ~2x the bits
    expect(qualityPlan(base({ videoCodec: 'mpeg4', sizeBytes: 60 * MiB }), 'original').maxrateBps).toBe(Math.floor(srcBps * 1.3));
    expect(qualityPlan(k4, 'balanced')).toMatchObject({ crf: 22, maxHeight: null, maxFps: null });
    expect(qualityPlan(base({ width: 7680, height: 4320 }), 'balanced').maxHeight).toBe(2160);
    expect(qualityPlan(k4, 'small')).toMatchObject({ crf: 28, maxHeight: 1080, maxFps: 30 });
    expect(qualityPlan(base({ width: 1280, height: 720, fps: 24 }), 'small')).toMatchObject({ maxHeight: null, maxFps: null });
    const src = (60 * MiB * 8) / 8;
    expect(qualityPlan(k4, 'balanced').maxrateBps!).toBeLessThan(src); expect(qualityPlan(k4, 'small').maxrateBps!).toBeLessThan(qualityPlan(k4, 'balanced').maxrateBps!);
  });
  it('notes only mention resolution when it really changed, and warn on heavy compression and HDR', () => {
    const src = base({ width: 1920, height: 1080 });
    expect(qualityNotes(src, { width: 1920, height: 1080, fps: 30, bytes: 4 * MiB, audioBps: 0 }, 'balanced').map(n => n.text).join(' ')).not.toMatch(/Resolution reduced|1080p/);
    expect(qualityNotes(base({ width: 3840, height: 2160 }), { width: 1920, height: 1080, fps: 30, bytes: 9 * MiB, audioBps: 0 }, 'small').map(n => n.text).join(' ')).toMatch(/Resolution reduced from 3840×2160 to 1920×1080/);
    expect(qualityNotes(base({ fps: 60 }), { width: 1920, height: 1080, fps: 30, bytes: 9 * MiB, audioBps: 0 }, 'small').map(n => n.text).join(' ')).toMatch(/Frame rate reduced from 60 to 30/);
    expect(qualityNotes(base({ hdr: true }), { width: 1920, height: 1080, fps: 30, bytes: 9 * MiB, audioBps: 0 }, 'original').some(n => n.level === 'warning' && /HDR/.test(n.text))).toBe(true);
    expect(qualityNotes(base({ duration: 60 }), { width: 1920, height: 1080, fps: 30, bytes: 1 * MiB, audioBps: 0 }, 'small').some(n => /compressed heavily/.test(n.text))).toBe(true);
    expect(qualityNotes(base({ duration: 60 }), { width: 1920, height: 1080, fps: 30, bytes: 1 * MiB, audioBps: 0 }, 'original')).toEqual([]);
  });
  it('the size-fit fallback maths still works (only used when a result exceeds the configured safeguard)', () => {
    expect(videoBitrate(60, 96_000)).toBeLessThan(videoBitrate(8, 96_000));
    expect(planEncode(base({ duration: 8 }))).toMatchObject({ ok: true });
    expect(ladderFor(640, 360).map(r => r.height)).toEqual([360]);
    expect(displaySize({ width: 1920, height: 1080, rotation: 90 })).toEqual({ width: 1080, height: 1920 });
    expect(nextBudget(TARGET_BYTES, 2 * TARGET_BYTES)).toBeLessThan(TARGET_BYTES);
  });
  it('parseProbe reads brand and HDR, and reports unusable files', () => {
    const ok = parseProbe(probeJson({ brand: 'qt  ', pix: 'yuv420p10le', transfer: 'arib-std-b67' }), 100);
    expect(ok.ok && ok.probe.brand).toBe('qt  '); expect(ok.ok && ok.probe.hdr).toBe(true);
    expect(parseProbe({}, 1)).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(parseProbe({ format: { format_name: 'mp3', duration: '5' }, streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }, 1)).toMatchObject({ ok: false, reason: 'no_video' });
  });
});

describe('processVideo: the three modes (FFmpeg replaced by a scripted runner, real files on disk)', () => {
  let dir = '';
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'o218-test-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** A tiny but real MP4 layout, so moovBeforeMdat reads true box headers: ftyp, then moov-or-mdat first. */
  const box = (type: string, len: number) => { const b = Buffer.alloc(len); b.writeUInt32BE(len, 0); b.write(type, 4, 'latin1'); return b; };
  const input = async (bytes: number, layout: 'moov-first' | 'mdat-first' | 'webm' | 'plain' = 'plain') => {
    const file = path.join(dir, 'input.bin');
    const head = layout === 'moov-first' ? Buffer.concat([box('ftyp', 24), box('moov', 40), box('mdat', 16)]) : layout === 'mdat-first' ? Buffer.concat([box('ftyp', 24), box('mdat', 40), box('moov', 16)]) : layout === 'webm' ? Buffer.from('\x1aE\xdf\xa3....webm....') : Buffer.alloc(0);
    await writeFile(file, head); await truncate(file, Math.max(bytes, head.length));
    return file;
  };

  type Script = { source?: P; outSizes?: number[]; remuxSize?: number; ffmpegCode?: number; timeout?: boolean; probeFails?: boolean; outOverride?: { codec?: string; audio?: string | null; dur?: number; w?: number; h?: number; pix?: string } };
  function script(opts: Script) {
    const ffmpegCalls: string[][] = []; const outputs = new Map<string, { v: string; w: number; h: number; fps: number; a: string | null; fmt: string; dur: number; pix: string }>(); let n = 0;
    const run: Runner = async (command, args) => {
      if (command === 'ffprobe') {
        if (opts.probeFails) return { code: 1, stdout: '', stderr: 'Invalid data', timedOut: false };
        const file = args[args.length - 1]; const out = outputs.get(file);
        const meta = out ? { ...opts.source, v: out.v, w: out.w, h: out.h, a: out.a, fmt: out.fmt, dur: out.dur, pix: out.pix, fps: `${out.fps}/1` } : opts.source;
        return { code: 0, stdout: JSON.stringify(probeJson(meta)), stderr: '', timedOut: false };
      }
      ffmpegCalls.push(args);
      if (opts.timeout) return { code: null, stdout: '', stderr: '', timedOut: true };
      if (opts.ffmpegCode) return { code: opts.ffmpegCode, stdout: '', stderr: 'boom', timedOut: false };
      const target = args[args.length - 1]; const src = { w: 1920, h: 1080, dur: 8, fps: 30, a: 'aac' as string | null, v: 'h264', ...opts.source, fps2: Number(String(opts.source?.fps ?? '30/1').split('/')[0]) };
      const copy = args.includes('copy') && args[args.indexOf('-c') + 1] === 'copy';
      const vf = args[args.indexOf('-vf') + 1] ?? '';
      const scaleH = /scale=-2:(\d+)/.exec(vf)?.[1]; const fpsF = /fps=(\d+)/.exec(vf)?.[1];
      const h = scaleH ? Number(scaleH) : src.h; const w = scaleH ? Math.round((src.w * h) / src.h / 2) * 2 : src.w;
      const o = opts.outOverride ?? {};
      outputs.set(target, { v: o.codec ?? (copy ? src.v : 'h264'), w: o.w ?? (copy ? src.w : w), h: o.h ?? (copy ? src.h : h), fps: fpsF ? Number(fpsF) : src.fps2, a: o.audio !== undefined ? o.audio : src.a, fmt: args.includes('webm') ? 'matroska,webm' : MP4_FMT, dur: o.dur ?? src.dur, pix: o.pix ?? 'yuv420p' });
      const sizes = opts.outSizes ?? [8 * MiB]; const size = copy ? (opts.remuxSize ?? 5 * MiB) : sizes[Math.min(n, sizes.length - 1)]; if (!copy) n += 1;
      await writeFile(target, ''); await truncate(target, size);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    return { run, ffmpegCalls };
  }
  const go = async (s: ReturnType<typeof script>, mode: OptimizeMode, bytes: number, layout: Parameters<typeof input>[1] = 'plain', extra: { maxOutputBytes?: number } = {}) => processVideo(await input(bytes, layout), dir, { run: s.run, mode, ...extra });

  describe('Original Quality (default)', () => {
    it('keeps a compatible MP4 whose index is up front byte for byte: no FFmpeg run at all', async () => {
      const s = script({ source: { brand: 'isom' } });
      const r = await go(s, 'original', 9 * MiB, 'moov-first');
      expect(r.info).toMatchObject({ mode: 'original', action: 'preserved', preserved: true, remuxed: false, reencoded: false, resized: false });
      expect(r.path).toBe(path.join(dir, 'input.bin')); expect(r.bytes).toBe(9 * MiB);
      expect(s.ffmpegCalls).toHaveLength(0);
      expect(r.info.final).toMatchObject({ width: 1920, height: 1080, videoCodec: 'h264' });
    });
    it('is NOT compressed just because it is small or large: a 40 MB compatible MP4 stays 40 MB at its resolution', async () => {
      const s = script({ source: { w: 3840, h: 2160, fps: '60/1' } });
      const r = await go(s, 'original', 40 * MiB, 'moov-first');
      expect(r.bytes).toBe(40 * MiB); expect(r.info.final).toMatchObject({ width: 3840, height: 2160, fps: 60 }); expect(r.info.resized).toBe(false); expect(s.ffmpegCalls).toHaveLength(0);
    });
    it('re-wraps (lossless stream copy, no re-encoding) when only the container needs fixing: index at the end, or a MOV', async () => {
      for (const [layout, brand] of [['mdat-first', 'isom'], ['plain', 'qt  ']] as const) {
        const s = script({ source: { brand }, remuxSize: 7 * MiB });
        const r = await go(s, 'original', 7 * MiB, layout);
        expect(r.info).toMatchObject({ action: 'remuxed', remuxed: true, reencoded: false, resized: false });
        expect(s.ffmpegCalls).toHaveLength(1);
        const args = s.ffmpegCalls[0].join(' ');
        expect(args).toContain('-c copy'); expect(args).toContain('+faststart'); expect(args).not.toContain('libx264'); expect(args).not.toContain('scale=');
        expect(r.info.summary).toMatch(/bit-for-bit unchanged/);
      }
    });
    it('compatible WebM: kept as it is, or re-wrapped into WebM with a stream copy', async () => {
      const webm = { fmt: 'matroska,webm', v: 'vp9', a: 'opus' };
      const kept = await go(script({ source: webm }), 'original', 5 * MiB, 'webm');
      expect(kept.info.action).toBe('preserved'); expect(kept.ext).toBe('webm'); expect(kept.mime).toBe('video/webm');
      const s = script({ source: webm });
      const wrapped = await go(s, 'original', 5 * MiB, 'plain');
      expect(wrapped.info.action).toBe('remuxed'); expect(wrapped.ext).toBe('webm'); expect(s.ffmpegCalls[0].join(' ')).toContain('-f webm');
    });
    it('only converts a codec browsers cannot play, at near-lossless quality and WITHOUT resizing or fps changes; says conversion may affect quality', async () => {
      const s = script({ source: { v: 'hevc', w: 3840, h: 2160, fps: '60/1', a: 'aac' }, outSizes: [40 * MiB] });
      const r = await go(s, 'original', 80 * MiB);
      const args = s.ffmpegCalls[0].join(' ');
      expect(args).toContain('-crf 17'); expect(args).not.toContain('scale='); expect(args).not.toContain('fps='); expect(args).toContain('-maxrate'); // bounded, never resized
      expect(args).toContain('-c:a copy'); // AAC audio is kept bit for bit
      expect(r.info).toMatchObject({ action: 'reencoded', reencoded: true, resized: false });
      expect(r.info.final).toMatchObject({ width: 3840, height: 2160, fps: 60, videoCodec: 'h264' });
      expect(r.warnings.join(' ')).toMatch(/Converted for browser playback because HEVC/); expect(r.warnings.join(' ')).toMatch(/slightly reduce quality/);
      expect(r.warnings.join(' ')).not.toMatch(/1080p|scaled down|Resolution reduced/);
    });
    it('flattening HDR / 10-bit is called out as a warning', async () => {
      const r = await go(script({ source: { v: 'hevc', pix: 'yuv420p10le', transfer: 'arib-std-b67' }, outSizes: [20 * MiB] }), 'original', 30 * MiB);
      expect(r.info.notes.some(n => n.level === 'warning' && /HDR/.test(n.text))).toBe(true);
    });
    it('output size boundary at the 45,000,000-byte default: 44,999,999 and 45,000,000 are accepted, 45,000,001 is refused', async () => {
      expect(videoConfig().maxOutputBytes).toBe(45_000_000);
      for (const size of [44_999_999, 45_000_000]) {
        const r = await go(script({ source: { v: 'hevc' }, outSizes: [size] }), 'original', 60 * MiB, 'plain', { maxOutputBytes: 45_000_000 });
        expect(r.bytes).toBe(size);
      }
      await expect(go(script({ source: { v: 'hevc' }, outSizes: [45_000_001] }), 'original', 60 * MiB, 'plain', { maxOutputBytes: 45_000_000 })).rejects.toMatchObject({ code: 'output_too_large', message: expect.stringContaining('45,000,000 bytes') });
    });
    it('a MOV is delivered as an MP4 (video/mp4), never as a MOV', async () => {
      const r = await go(script({ source: { brand: 'qt  ' } }), 'original', 9 * MiB, 'plain');
      expect(r.ext).toBe('mp4'); expect(r.mime).toBe('video/mp4'); expect(r.info.final.container).toBe('mp4');
    });
    it('never silently degrades to fit a limit: a conversion or a file above the configured safeguard is refused with the way forward', async () => {
      await expect(go(script({ source: { v: 'hevc' }, outSizes: [30 * MiB] }), 'original', 50 * MiB, 'plain', { maxOutputBytes: 20 * MiB })).rejects.toMatchObject({ code: 'output_too_large' });
      await expect(go(script({}), 'original', 30 * MiB, 'moov-first', { maxOutputBytes: 20 * MiB })).rejects.toMatchObject({ code: 'output_too_large', message: expect.stringContaining('Balanced') });
    });
  });

  describe('Auto Compress — Balanced', () => {
    it('re-encodes with CRF 22 at the original resolution and frame rate, a ceiling relative to the source bitrate, and never mentions 1080p', async () => {
      const s = script({ source: { w: 1920, h: 1080 }, outSizes: [14 * MiB] });
      const r = await go(s, 'balanced', 40 * MiB, 'moov-first');
      const args = s.ffmpegCalls[0].join(' ');
      expect(args).toContain('-crf 22'); expect(args).toContain('-maxrate'); expect(args).not.toContain('scale='); expect(args).not.toContain('fps=');
      expect(r.info).toMatchObject({ mode: 'balanced', action: 'reencoded', resized: false });
      expect(r.bytes).toBe(14 * MiB); expect(r.warnings.join(' ')).not.toMatch(/1080p|Resolution reduced/);
    });
    it('keeps the ORIGINAL when compressing would not meaningfully shrink an already-efficient compatible file', async () => {
      const s = script({ source: {}, outSizes: [9.5 * MiB] });
      const r = await go(s, 'balanced', 10 * MiB, 'moov-first');
      expect(r.info.action).toBe('preserved'); expect(r.path).toBe(path.join(dir, 'input.bin')); expect(r.bytes).toBe(10 * MiB);
      expect(r.warnings.join(' ')).toMatch(/would not make this file meaningfully smaller/);
    });
    it('downscales only when necessary (8K -> 4K) and says exactly that', async () => {
      const s = script({ source: { w: 7680, h: 4320 }, outSizes: [40 * MiB] });
      const r = await go(s, 'balanced', 300 * MiB);
      expect(s.ffmpegCalls[0].join(' ')).toContain('scale=-2:2160');
      expect(r.info.resized).toBe(true); expect(r.warnings.join(' ')).toMatch(/Resolution reduced from 7680×4320 to 3840×2160/);
    });
    it('only if the result would exceed the configured safeguard does it reduce further, as little as needed, and it reports that', async () => {
      const s = script({ source: { dur: 100 }, outSizes: [70 * MiB, 30 * MiB, 18 * MiB] });
      const r = await go(s, 'balanced', 500 * MiB, 'plain', { maxOutputBytes: 20 * MiB });
      expect(r.bytes).toBeLessThanOrEqual(20 * MiB); expect(r.info.attempts).toBeGreaterThanOrEqual(2);
      expect(r.info.summary).toMatch(/Compressed to fit this server's/);
    });
    it('never reports success when the result stays above the safeguard', async () => {
      await expect(go(script({ outSizes: [70 * MiB] }), 'balanced', 500 * MiB, 'plain', { maxOutputBytes: 20 * MiB })).rejects.toMatchObject({ code: 'cannot_fit' });
    });
  });

  describe('Auto Compress — Smaller Size', () => {
    it('uses stronger compression, caps a 4K 60 fps source to 1080p / 30 fps, and reports both real changes', async () => {
      const s = script({ source: { w: 3840, h: 2160, fps: '60/1' }, outSizes: [9 * MiB] });
      const r = await go(s, 'small', 60 * MiB);
      const args = s.ffmpegCalls[0].join(' ');
      expect(args).toContain('-crf 28'); expect(args).toContain('scale=-2:1080'); expect(args).toContain('fps=30'); expect(args).toContain('-preset faster');
      expect(r.info).toMatchObject({ mode: 'small', action: 'reencoded', resized: true });
      expect(r.info.final).toMatchObject({ width: 1920, height: 1080, fps: 30 });
      expect(r.warnings.join(' ')).toMatch(/Resolution reduced from 3840×2160 to 1920×1080/); expect(r.warnings.join(' ')).toMatch(/Frame rate reduced from 60 to 30/);
    });
    it('never upscales and never touches aspect ratio: a 720p source stays 720p; a portrait source stays portrait', async () => {
      const s = script({ source: { w: 1280, h: 720 }, outSizes: [3 * MiB] });
      const r = await go(s, 'small', 20 * MiB); expect(s.ffmpegCalls[0].join(' ')).not.toContain('scale='); expect(r.info.resized).toBe(false);
      const p = script({ source: { w: 2160, h: 3840 }, outSizes: [8 * MiB] });
      const pr = await go(p, 'small', 40 * MiB); expect(pr.info.final.width / pr.info.final.height).toBeCloseTo(2160 / 3840, 1);
    });
    it('warns when compression is heavy', async () => {
      const r = await go(script({ source: { dur: 60 }, outSizes: [1 * MiB] }), 'small', 40 * MiB);
      expect(r.warnings.join(' ')).toMatch(/compressed heavily/);
    });
  });

  describe('verification and failures (every mode)', () => {
    it('a stretched output, a wrong codec, lost audio or a changed duration is never published', async () => {
      await expect(go(script({ source: { w: 1080, h: 1920 }, outOverride: { w: 1920, h: 1080 }, outSizes: [8 * MiB] }), 'balanced', 30 * MiB)).rejects.toMatchObject({ code: 'verify_failed' });
      await expect(go(script({ outOverride: { codec: 'vp9' }, outSizes: [8 * MiB] }), 'balanced', 30 * MiB)).rejects.toMatchObject({ code: 'verify_failed' });
      await expect(go(script({ outOverride: { audio: null }, outSizes: [8 * MiB] }), 'balanced', 30 * MiB)).rejects.toMatchObject({ code: 'verify_failed' });
      await expect(go(script({ source: { dur: 10 }, outOverride: { dur: 4 }, outSizes: [8 * MiB] }), 'balanced', 30 * MiB)).rejects.toMatchObject({ code: 'verify_failed' });
    });
    it('explains unreadable / no-video / encoder failure / timeout / too long', async () => {
      await expect(go(script({ probeFails: true }), 'original', 5 * MiB)).rejects.toMatchObject({ code: 'unreadable' });
      await expect(go(script({ source: { v: 'hevc' }, ffmpegCode: 1 }), 'original', 30 * MiB)).rejects.toMatchObject({ code: 'encode_failed' });
      await expect(go(script({ source: { v: 'hevc' }, timeout: true }), 'original', 30 * MiB)).rejects.toMatchObject({ code: 'timeout' });
      await expect(go(script({ source: { dur: 900 } }), 'original', 30 * MiB)).rejects.toMatchObject({ code: 'too_long', message: expect.stringContaining('HERO_VIDEO_MAX_DURATION_S') });
      const noVideo: Runner = async (c) => (c === 'ffprobe' ? { code: 0, stdout: JSON.stringify({ format: { format_name: 'mp3', duration: '5' }, streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }), stderr: '', timedOut: false } : { code: 0, stdout: '', stderr: '', timedOut: false });
      await expect(processVideo(await input(1 * MiB), dir, { run: noVideo })).rejects.toBeInstanceOf(VideoError);
    });
    it('the maximum duration is a configurable safeguard', async () => {
      process.env.HERO_VIDEO_MAX_DURATION_S = '1000';
      try { const r = await go(script({ source: { dur: 900 } }), 'original', 30 * MiB, 'moov-first'); expect(r.info.action).toBe('preserved'); } finally { delete process.env.HERO_VIDEO_MAX_DURATION_S; }
    });
    it('encode commands go through argument arrays only', () => {
      const args = qualityArgs('/tmp/x/input.bin', '/tmp/x/output.mp4', qualityPlan(base(), 'balanced'), base());
      expect(args.every(a => typeof a === 'string')).toBe(true); expect(args).toContain('-nostdin');
    });
    it('moovBeforeMdat reads real box headers', async () => {
      expect(await moovBeforeMdat(await input(1000, 'moov-first'))).toBe(true);
      expect(await moovBeforeMdat(await input(1000, 'mdat-first'))).toBe(false);
    });
    it('stat is real: the file reported is the file on disk', async () => {
      const r = await go(script({ source: { v: 'hevc' }, outSizes: [6 * MiB] }), 'original', 20 * MiB);
      expect((await stat(r.path)).size).toBe(6 * MiB);
    });
  });
});

describe('ffmpeg availability', () => {
  beforeEach(() => resetFfmpegAvailability());
  it('is true only when ffprobe runs and the H.264 and AAC encoders exist', async () => {
    const ok: Runner = async (c) => ({ code: 0, stdout: c === 'ffprobe' ? 'ffprobe version 7' : ' V....D libx264 H.264\n A....D aac AAC', stderr: '', timedOut: false });
    expect(await ffmpegAvailable(ok)).toBe(true);
    resetFfmpegAvailability();
    expect(await ffmpegAvailable(async () => ({ code: null, stdout: '', stderr: 'spawn ffmpeg ENOENT', timedOut: false }))).toBe(false);
    resetFfmpegAvailability();
    expect(await ffmpegAvailable(async (c) => ({ code: 0, stdout: c === 'ffprobe' ? 'v' : ' V....D mpeg4', stderr: '', timedOut: false }))).toBe(false);
  });
});
