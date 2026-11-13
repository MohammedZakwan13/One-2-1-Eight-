import 'server-only';
import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MAX_OUTPUT_BYTES, LIMIT_LABEL, MB, MIN_DURATION_SECONDS, browserCompat, displaySize, nextBudget, parseProbe, planEncode, qualityNotes, qualityPlan, type OptimizeMode, type Probe, type QualityPlan, type QualityWarning } from '@/lib/video-plan';

/**
 * Server-side video normalisation with FFmpeg: any common container in, an H.264 / AAC / yuv420p MP4 (fast-start) of at most 12 MB out.
 * FFmpeg is only ever run with an argument ARRAY (never a shell string), on a file we wrote ourselves, with a hard timeout.
 * Nothing here talks to storage: callers get a verified file on disk or a VideoError that explains what to change.
 */

const MiB = 1024 * 1024;
const num = (value: string | undefined, fallback: number) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; };
export const videoConfig = () => ({
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
  /**
   * There is NO built-in cap on the size of an ORIGINAL upload: large files arrive in chunks and the real limit is free disk space.
   * An operator may add a guard with HERO_VIDEO_MAX_SOURCE_MB; unset (the default) means no cap.
   */
  maxSourceBytes: Math.max(0, num(process.env.HERO_VIDEO_MAX_SOURCE_MB, 0)) * MiB,
  chunkBytes: 8 * MiB,
  /** Safeguard for the PROCESSED file (not a quality target). Must not exceed the `banner-media` bucket limit (migration 0013). */
  maxOutputBytes: process.env.HERO_VIDEO_MAX_OUTPUT_MB ? Math.max(5, num(process.env.HERO_VIDEO_MAX_OUTPUT_MB, 0)) * MiB : DEFAULT_MAX_OUTPUT_BYTES, // env override is in MiB; the default is exactly 45,000,000 bytes
  /** Longest source accepted (a safeguard for processing time, not a quality rule). */
  maxDurationSeconds: Math.max(5, num(process.env.HERO_VIDEO_MAX_DURATION_S, 300)),
  maxSessions: Math.min(10, Math.max(1, Math.floor(num(process.env.HERO_VIDEO_MAX_UPLOADS, 3)))),
  /** Minimum time a job may run; longer clips get more (see processVideo). */
  jobTimeoutMs: Math.min(3600, Math.max(60, num(process.env.HERO_VIDEO_JOB_TIMEOUT_S, 420))) * 1000,
  maxConcurrent: Math.min(2, Math.max(1, Math.floor(num(process.env.HERO_VIDEO_CONCURRENCY, 1)))),
  maxQueued: Math.min(10, Math.max(1, Math.floor(num(process.env.HERO_VIDEO_MAX_QUEUE, 3)))),
  tmpDir: process.env.HERO_VIDEO_TMP_DIR || path.join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'o218-video'),
  nice: process.env.HERO_VIDEO_NICE !== '0',
});

export type VideoErrorCode = 'unavailable' | 'output_too_large' | 'unreadable' | 'no_video' | 'too_long' | 'too_short' | 'cannot_fit' | 'encode_failed' | 'timeout' | 'verify_failed';
export class VideoError extends Error {
  constructor(public code: VideoErrorCode, message: string) { super(message); }
}

export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Runner = (command: string, args: string[], options: { timeoutMs: number; onLine?: (line: string) => void }) => Promise<RunResult>;

/** Default runner: spawn without a shell, low CPU priority (so customers browsing the site come first), bounded output, killed on timeout. */
export const spawnRunner: Runner = (command, args, { timeoutMs, onLine }) => new Promise(resolve => {
  const config = videoConfig();
  const useNice = config.nice && process.platform !== 'win32' && /ffmpeg/.test(path.basename(command));
  const child = useNice ? spawn('nice', ['-n', '10', command, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let timedOut = false; let buffer = '';
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (stdout.length < 1_000_000) stdout += text;
    if (onLine) { buffer += text; const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) onLine(line.trim()); }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
  child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut }); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
});

let availability: { ok: boolean; at: number } | null = null;
/** True only when ffmpeg and ffprobe run AND the H.264 and AAC encoders exist. Cached (a failure is rechecked after a minute). */
export async function ffmpegAvailable(run: Runner = spawnRunner): Promise<boolean> {
  if (availability && (availability.ok || Date.now() - availability.at < 60_000)) return availability.ok;
  const { ffmpeg, ffprobe } = videoConfig();
  const [probe, encoders] = await Promise.all([run(ffprobe, ['-version'], { timeoutMs: 5000 }), run(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 8000 })]);
  const ok = probe.code === 0 && encoders.code === 0 && /\blibx264\b/.test(encoders.stdout) && /\baac\b/.test(encoders.stdout);
  availability = { ok, at: Date.now() };
  return ok;
}
export const resetFfmpegAvailability = () => { availability = null; };
/**
 * Video processing is a hard requirement of banner uploads: there is no fallback to the old MP4/WebM-12MB rules. When FFmpeg or one of its
 * encoders is missing the admin is told exactly that (and the production image build fails before such a server can be deployed).
 */
export async function requireFfmpeg(run: Runner = spawnRunner): Promise<void> {
  if (!(await ffmpegAvailable(run))) throw new VideoError('unavailable', 'Video processing is not available on this server: FFmpeg (with the H.264 and AAC encoders) is not installed. Ask the administrator to install it (see docs/DEPLOYMENT.md). The video was not uploaded.');
}

export async function probeVideo(file: string, run: Runner, timeoutMs: number): Promise<Probe> {
  const result = await run(videoConfig().ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: Math.min(timeoutMs, 30_000) });
  if (result.timedOut) throw new VideoError('timeout', 'Reading the video took too long.');
  let json: unknown = null;
  if (result.code === 0) { try { json = JSON.parse(result.stdout); } catch { /* handled below */ } }
  const parsed = parseProbe(json, (await stat(file)).size);
  if (!parsed.ok) {
    if (parsed.reason === 'no_video') throw new VideoError('no_video', 'This file has no video track. Upload a video file.');
    throw new VideoError('unreadable', 'This file could not be read as a video. It may be corrupt, encrypted or in an unsupported format. Try exporting it again as MP4 or MOV.');
  }
  return parsed.probe;
}

export type VideoStage = 'analyzing' | 'converting' | 'compressing';
export type VideoAction = 'preserved' | 'remuxed' | 'reencoded';
export type VideoFacts = { bytes: number; width: number; height: number; fps: number; videoCodec: string; audioCodec: string | null };
/** Everything the admin is shown about a processed video. Every flag describes what REALLY happened to the file. */
export type VideoInfo = {
  mode: OptimizeMode; action: VideoAction; preserved: boolean; remuxed: boolean; reencoded: boolean; resized: boolean; summary: string; attempts: number;
  original: VideoFacts & { container: string; durationSeconds: number }; final: VideoFacts & { container: 'mp4' | 'webm' }; notes: QualityWarning[];
};
export type VideoResult = { path: string; ext: 'mp4' | 'webm'; mime: string; bytes: number; width: number; height: number; duration: number; audioCodec: string | null; info: VideoInfo; warnings: string[] };
type Options = { run?: Runner; onStage?: (stage: VideoStage, percent: number) => void; timeoutMs?: number; mode?: OptimizeMode; maxOutputBytes?: number; /** Test hook: start the size-fit fallback from a larger budget. */ initialBudgetBytes?: number };

const remuxArgs = (input: string, output: string, container: 'mp4' | 'webm') => ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-sn', '-dn', '-map_metadata', '-1', ...(container === 'mp4' ? ['-movflags', '+faststart'] : ['-f', 'webm']), output];

/** The fixed-bitrate encoder used only by the "fit the stored size limit" fallback. */
export function encodeArgs(input: string, output: string, plan: { rung: { height: number }; fps: number; videoBps: number; audioBps: number }, sourceHeight: number, sourceFps: number): string[] {
  const filters = [plan.rung.height < sourceHeight ? `scale=-2:${plan.rung.height}:flags=lanczos` : null, plan.fps < sourceFps - 0.5 ? `fps=${plan.fps}` : null, 'format=yuv420p'].filter(Boolean).join(',');
  const args = ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', filters,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-b:v', String(plan.videoBps), '-maxrate', String(Math.floor(plan.videoBps * 1.3)), '-bufsize', String(plan.videoBps * 2),
    '-pix_fmt', 'yuv420p', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart'];
  if (plan.audioBps > 0) args.push('-c:a', 'aac', '-b:a', String(plan.audioBps), '-ac', '2');
  return [...args, output];
}

/** Quality-first encoder: constant quality (CRF) with an optional bitrate ceiling, scaling and frame-rate limits only when the plan asks for them. */
export function qualityArgs(input: string, output: string, plan: QualityPlan, source: Probe): string[] {
  const view = displaySize(source);
  const filters = [plan.maxHeight && view.height > plan.maxHeight ? `scale=-2:${plan.maxHeight}:flags=lanczos` : null, plan.maxFps && source.fps > plan.maxFps ? `fps=${plan.maxFps}` : null, 'format=yuv420p'].filter(Boolean).join(',');
  const args = ['-y', '-hide_banner', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', filters, '-c:v', 'libx264', '-preset', plan.preset, '-crf', String(plan.crf)];
  if (plan.maxrateBps) args.push('-maxrate', String(plan.maxrateBps), '-bufsize', String(plan.maxrateBps * 2));
  args.push('-pix_fmt', 'yuv420p', '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart');
  if (source.audioCodec === 'aac') args.push('-c:a', 'copy'); // already AAC: keep the audio bit for bit
  else if (source.audioCodec !== null) args.push('-c:a', 'aac', '-b:a', String(plan.audioBps), '-ac', '2');
  return [...args, output];
}

/** Is the MP4's index (`moov`) before the media data (`mdat`)? Reads only box headers, never the whole file. */
export async function moovBeforeMdat(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size; let offset = 0;
    for (let i = 0; i < 64 && offset + 8 <= size; i += 1) {
      const head = Buffer.alloc(16); await handle.read(head, 0, 16, offset);
      let length = head.readUInt32BE(0); const type = head.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (length === 1) length = Number(head.readBigUInt64BE(8)); else if (length === 0) return false;
      if (length < 8) return false;
      offset += length;
    }
    return false;
  } finally { await handle.close(); }
}
async function looksLikeWebm(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try { const head = Buffer.alloc(64); await handle.read(head, 0, 64, 0); return head.toString('latin1').includes('webm'); } finally { await handle.close(); }
}

const facts = (p: Probe, bytes: number): VideoFacts => ({ bytes, ...displaySize(p), fps: Math.round(p.fps * 100) / 100, videoCodec: p.videoCodec, audioCodec: p.audioCodec });

/** Checks the produced file itself (not our intentions): size, container, codec, pixel format, duration, shape and audio. */
async function verify(output: string, source: Probe, run: Runner, timeoutMs: number, expect: { maxBytes: number; container: 'mp4' | 'webm'; videoCodec: string }): Promise<{ bytes: number; probe: Probe }> {
  const bytes = (await stat(output)).size;
  if (bytes <= 0) throw new VideoError('verify_failed', 'The processed video is empty.');
  if (bytes > expect.maxBytes) throw new VideoError('output_too_large', `The processed video is ${MB(bytes)}, above this server's ${LIMIT_LABEL(expect.maxBytes)} limit for banner videos.`);
  const probe = await probeVideo(output, run, timeoutMs);
  const src = displaySize(source); const out = displaySize(probe);
  const problems: string[] = [];
  if (probe.videoCodec !== expect.videoCodec) problems.push(`video codec is ${probe.videoCodec}`);
  if (!probe.formatNames.includes(expect.container === 'mp4' ? 'mp4' : 'webm')) problems.push(`container is not ${expect.container.toUpperCase()}`);
  if (probe.pixelFormat !== 'yuv420p') problems.push(`pixel format is ${probe.pixelFormat}`);
  if (Math.abs(probe.duration - source.duration) > Math.max(0.6, source.duration * 0.03)) problems.push('duration changed');
  if (Math.abs(out.width / out.height - src.width / src.height) / (src.width / src.height) > 0.015) problems.push('aspect ratio changed');
  if (source.audioCodec && !probe.audioCodec) problems.push('audio was lost');
  if (problems.length) throw new VideoError('verify_failed', `The processed video failed verification (${problems.join(', ')}).`);
  return { bytes, probe };
}

/**
 * Turn an upload into a browser-ready banner video according to the admin's mode. The file produced is always measured and probed before it is
 * reported, and what is reported (preserved / re-wrapped / re-encoded / resized) is what actually happened.
 *   original (default): keep the file when browsers can play it (byte for byte if its index is up front, otherwise a lossless stream-copy
 *                       re-wrap); only a codec that browsers cannot play is converted, at near-lossless quality and without resizing.
 *   balanced:           re-encode at the original resolution and frame rate with a quality-first setting; if that would not make the file
 *                       meaningfully smaller, the original is kept instead.
 *   small:              stronger compression, at most 1080p and 30 fps.
 */
export async function processVideo(input: string, outDir: string, options: Options = {}): Promise<VideoResult> {
  const run = options.run ?? spawnRunner;
  const config = videoConfig();
  const mode = options.mode ?? 'original';
  const maxBytes = options.maxOutputBytes ?? config.maxOutputBytes;
  const { ffmpeg } = config;
  let deadline = Date.now() + (options.timeoutMs ?? config.jobTimeoutMs);
  const left = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new VideoError('timeout', 'Processing took too long. Try a shorter or smaller video, or a smaller-size mode.'); return ms; };
  const outMp4 = path.join(outDir, 'output.mp4'); const outWebm = path.join(outDir, 'output.webm');

  options.onStage?.('analyzing', 0);
  const source = await probeVideo(input, run, left());
  if (source.duration < MIN_DURATION_SECONDS) throw new VideoError('too_short', 'This video is shorter than half a second.');
  if (source.duration > config.maxDurationSeconds) throw new VideoError('too_long', `This video is ${Math.round(source.duration)} seconds long. This server accepts banner videos up to ${config.maxDurationSeconds} seconds (HERO_VIDEO_MAX_DURATION_S); a homepage video of 6–10 seconds is ideal.`);
  if (!options.timeoutMs) deadline = Math.max(deadline, Date.now() + Math.min(3_600_000, source.duration * 12_000)); // long or heavy sources get proportionally more time
  const compat = browserCompat(source);
  const original = { ...facts(source, source.sizeBytes), container: source.formatNames[0] ?? 'unknown', durationSeconds: Math.round(source.duration * 100) / 100 };

  const finish = (partial: { path: string; ext: 'mp4' | 'webm'; bytes: number; probe: Probe; action: VideoAction; summary: string; attempts: number; extraNotes?: QualityWarning[]; audioBps?: number }): VideoResult => {
    const f = facts(partial.probe, partial.bytes);
    const resized = f.width < original.width - 1 || f.height < original.height - 1;
    const notes = [...(partial.extraNotes ?? []), ...(partial.action === 'reencoded' ? qualityNotes(source, { width: f.width, height: f.height, fps: f.fps, bytes: partial.bytes, audioBps: partial.audioBps ?? 0 }, mode) : [])];
    const info: VideoInfo = { mode, action: partial.action, preserved: partial.action === 'preserved', remuxed: partial.action === 'remuxed', reencoded: partial.action === 'reencoded', resized, summary: partial.summary, attempts: partial.attempts, original, final: { ...f, container: partial.ext }, notes };
    return { path: partial.path, ext: partial.ext, mime: partial.ext === 'mp4' ? 'video/mp4' : 'video/webm', bytes: partial.bytes, width: f.width, height: f.height, duration: partial.probe.duration, audioCodec: partial.probe.audioCodec, info, warnings: notes.map(n => n.text) };
  };

  /** Browser-compatible source: keep it as it is, or re-wrap it without touching the video and audio streams. */
  const keepOriginal = async (extraNotes: QualityWarning[] = []): Promise<VideoResult> => {
    if (!compat.ok) throw new VideoError('encode_failed', 'This video cannot be kept as it is.');
    const container = compat.container;
    const already = container === 'mp4' ? source.brand !== 'qt  ' && (await moovBeforeMdat(input)) : await looksLikeWebm(input);
    if (already) {
      if (source.sizeBytes > maxBytes) throw new VideoError('output_too_large', `This video is ${MB(source.sizeBytes)}, above this server's ${LIMIT_LABEL(maxBytes)} limit for banner videos. Choose "Auto Compress — Balanced" or "Smaller Size".`);
      return finish({ path: input, ext: container, bytes: source.sizeBytes, probe: source, action: 'preserved', attempts: 0, extraNotes, summary: 'The original file was kept exactly as uploaded: it is already browser-compatible.' });
    }
    options.onStage?.('converting', 0);
    const target = container === 'mp4' ? outMp4 : outWebm;
    const result = await run(ffmpeg, remuxArgs(input, target, container), { timeoutMs: left() });
    if (result.timedOut) throw new VideoError('timeout', 'Processing took too long.');
    if (result.code !== 0) throw new VideoError('encode_failed', 'The video could not be re-wrapped into a browser-friendly file. Try "Auto Compress — Balanced" to convert it instead.');
    const done = await verify(target, source, run, left(), { maxBytes, container, videoCodec: source.videoCodec });
    return finish({ path: target, ext: container, bytes: done.bytes, probe: done.probe, action: 'remuxed', attempts: 0, extraNotes, summary: 'Re-wrapped into a browser-friendly file without re-encoding: the video and audio streams are bit-for-bit unchanged.' });
  };

  if (mode === 'original' && compat.ok) return keepOriginal();

  // ── a conversion or compression is needed (or was requested) ──
  const plan = qualityPlan(source, mode);
  options.onStage?.('converting', 0);
  const encodeOnce = async (args: string[], stage: 'converting' | 'compressing') => {
    const result = await run(ffmpeg, args, {
      timeoutMs: left(),
      onLine: line => { const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); if (m) options.onStage?.(stage, Math.min(99, Math.round((Number(m[1]) / 1_000_000 / source.duration) * 100))); },
    });
    if (result.timedOut) throw new VideoError('timeout', 'Processing took too long. Try a shorter or smaller video, or a smaller-size mode.');
    if (result.code !== 0) throw new VideoError('encode_failed', 'The video could not be converted. It may use a codec or protection this server cannot read. Try exporting it as MP4 (H.264) or MOV from your editing app.');
    return (await stat(outMp4)).size;
  };
  let bytes = await encodeOnce(qualityArgs(input, outMp4, plan, source), 'converting');
  let attempts = 1;
  let summary = plan.explain;
  const extra: QualityWarning[] = [];

  if (bytes > maxBytes) {
    if (mode === 'original') throw new VideoError('output_too_large', `Converting this video at original quality would make a ${MB(bytes)} file, above this server's ${LIMIT_LABEL(maxBytes)} limit for banner videos. Choose "Auto Compress — Balanced" or "Smaller Size", or upload a shorter clip.`);
    // Compressed result still above the safeguard: fit it, reducing resolution only as much as the budget demands.
    let budget = options.initialBudgetBytes ?? Math.floor(maxBytes * 0.9);
    for (let attempt = 1; attempt <= 3 && bytes > maxBytes; attempt += 1) {
      const fit = planEncode(source, budget);
      if (!fit.ok) throw new VideoError('cannot_fit', `This ${Math.round(source.duration)}-second video cannot be compressed under this server's ${LIMIT_LABEL(maxBytes)} limit without looking poor. Upload a shorter clip or one with a lower resolution.`);
      bytes = await encodeOnce(encodeArgs(input, outMp4, fit, displaySize(source).height, source.fps), 'compressing');
      attempts += 1; budget = nextBudget(budget, bytes);
    }
    if (bytes > maxBytes) throw new VideoError('cannot_fit', `This video could not be compressed under this server's ${LIMIT_LABEL(maxBytes)} limit. Upload a shorter clip or a lower-resolution version.`);
    summary = `Compressed to fit this server's ${LIMIT_LABEL(maxBytes)} storage limit.`;
  }

  // Balanced / Smaller on a file that browsers can already play: if compressing did not help meaningfully, keep the original.
  if (compat.ok && mode !== 'original' && bytes >= source.sizeBytes * 0.92) {
    return keepOriginal([{ level: 'info', text: `Compression would not make this file meaningfully smaller (${MB(bytes)} vs ${MB(source.sizeBytes)} original), so the original quality was kept.` }]);
  }

  const done = await verify(outMp4, source, run, left(), { maxBytes, container: 'mp4', videoCodec: 'h264' });
  if (!compat.ok) extra.push({ level: 'info', text: `Converted for browser playback because ${compat.reason}. Converting can slightly reduce quality.` });
  return finish({ path: outMp4, ext: 'mp4', bytes: done.bytes, probe: done.probe, action: 'reencoded', attempts, summary, extraNotes: extra, audioBps: source.audioCodec && source.audioCodec !== 'aac' ? plan.audioBps : 0 });
}
