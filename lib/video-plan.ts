/**
 * Pure planning rules for banner videos. No I/O, so every rule is unit-tested without FFmpeg; the server module
 * (lib/backend/video-transcode.ts) only executes what is planned here.
 *
 * There is NO fixed output size. The admin picks one of three modes (default: original quality) and the only size limit left is a
 * configurable infrastructure safeguard (HERO_VIDEO_MAX_OUTPUT_MB, which must not exceed the storage bucket's own limit).
 */

/**
 * Default for the configurable output safeguard (HERO_VIDEO_MAX_OUTPUT_MB): 45,000,000 bytes, deliberately below the Supabase Free plan's project-wide
 * per-file limit of 50,000,000 bytes (and below the 52,428,800-byte `banner-media` bucket limit from migration 0013). A file of exactly 45,000,000
 * bytes is accepted, one byte more is refused. Raise HERO_VIDEO_MAX_OUTPUT_MB (and the Supabase limits) after upgrading Supabase.
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 45_000_000;
/** A size as the limit messages show it: decimal MB (what Supabase counts) and the exact byte count. */
export const LIMIT_LABEL = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB (${bytes.toLocaleString('en-US')} bytes)`;
/** Unchanged planning constants (compatibility check and size-fit fallback). They are not the storage limit; the configured safeguard above is. */
export const FINAL_MAX_BYTES = 100 * 1024 * 1024;
/** Aim a little under the hard limit: container overhead and rate-control drift must never push the file over 12 MB. */
export const TARGET_BYTES = Math.floor(FINAL_MAX_BYTES * 0.9);
export const AUDIO_BPS = 96_000;
export const AUDIO_BPS_LOW = 64_000;
/** Longest clip we will even try to fit; beyond this the picture would have to be unacceptably soft. */
export const MAX_DURATION_SECONDS = 300;
export const MIN_DURATION_SECONDS = 0.5;
/** Bits per pixel per frame below which H.264 looks visibly poor. A rung (resolution) is used only while its budget stays above this. */
export const MIN_BITS_PER_PIXEL = 0.035;
export const MAX_HEIGHT = 1080;
export const MAX_FPS = 30;
export const HEIGHT_LADDER = [1080, 720, 540, 480, 360] as const;

export type Probe = {
  duration: number; width: number; height: number; fps: number; videoCodec: string; pixelFormat: string; audioCodec: string | null;
  formatNames: string[]; rotation: number; sizeBytes: number;
  /** MP4/MOV major brand (e.g. 'isom', 'mp42', 'qt  '); '' when not reported. */ brand: string;
  /** True for 10-bit or HDR (HLG / PQ) video. */ hdr: boolean;
};

/** Reads the fields we need from `ffprobe -print_format json -show_format -show_streams`. Anything unusable is reported, never guessed. */
export function parseProbe(raw: unknown, sizeBytes: number): { ok: true; probe: Probe } | { ok: false; reason: 'unreadable' | 'no_video' | 'no_duration'; detail: string } {
  const doc = (raw ?? {}) as { format?: { format_name?: string; duration?: string; tags?: Record<string, string> }; streams?: Array<Record<string, unknown>> };
  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  if (!doc.format || streams.length === 0) return { ok: false, reason: 'unreadable', detail: 'No readable media streams were found.' };
  const video = streams.find(s => s.codec_type === 'video' && !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  if (!video) return { ok: false, reason: 'no_video', detail: 'The file has no video track.' };
  const audio = streams.find(s => s.codec_type === 'audio');
  const duration = Number(doc.format.duration ?? video.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) return { ok: false, reason: 'no_duration', detail: 'The video length could not be determined.' };
  const frac = (value: unknown) => { const [a, b] = String(value ?? '0/1').split('/').map(Number); return b ? a / b : Number(a) || 0; };
  const side = (video.side_data_list as Array<{ rotation?: number }> | undefined)?.find(item => typeof item.rotation === 'number')?.rotation ?? Number((video.tags as { rotate?: string } | undefined)?.rotate ?? 0);
  return {
    ok: true,
    probe: {
      duration, width: Number(video.width ?? 0), height: Number(video.height ?? 0), fps: frac(video.avg_frame_rate) || frac(video.r_frame_rate) || 25,
      videoCodec: String(video.codec_name ?? ''), pixelFormat: String(video.pix_fmt ?? ''), audioCodec: audio ? String(audio.codec_name ?? '') : null,
      formatNames: String(doc.format.format_name ?? '').split(',').filter(Boolean), rotation: ((Math.round(side) % 360) + 360) % 360, sizeBytes,
      brand: String(doc.format.tags?.major_brand ?? ''),
      hdr: /10|12/.test(String(video.pix_fmt ?? '')) || /arib-std-b67|smpte2084/.test(String(video.color_transfer ?? '')),
    },
  };
}

/** Width and height as the viewer sees them (a phone clip stored sideways with a rotation flag swaps the two). */
export const displaySize = (probe: Pick<Probe, 'width' | 'height' | 'rotation'>) => (probe.rotation === 90 || probe.rotation === 270 ? { width: probe.height, height: probe.width } : { width: probe.width, height: probe.height });

/** Video bits per second that fit `targetBytes` for this duration after reserving audio and ~2% container overhead. */
export function videoBitrate(durationSeconds: number, audioBps: number, targetBytes = TARGET_BYTES): number {
  return Math.floor((targetBytes * 8 * 0.98) / durationSeconds - audioBps);
}

/** The smallest video bitrate that still looks acceptable at this size. */
export const minBitrateFor = (width: number, height: number, fps: number) => Math.ceil(MIN_BITS_PER_PIXEL * width * height * Math.min(fps, MAX_FPS));

export type Rung = { height: number; width: number };

/** Heights to try, largest first: never above the source (no upscaling), never above 1080p, even-numbered and aspect-preserving. */
export function ladderFor(width: number, height: number): Rung[] {
  const top = Math.min(height, MAX_HEIGHT);
  const heights = [...new Set([top, ...HEIGHT_LADDER.filter(h => h < top)])].sort((a, b) => b - a);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return heights.map(h => ({ height: even(h), width: even((width * h) / height) }));
}

export type Plan = { ok: true; rung: Rung; fps: number; videoBps: number; audioBps: number } | { ok: false; maxSeconds: number };

/**
 * Choose the highest resolution whose budget still gives acceptable quality; if even the smallest rung cannot, report how long a clip
 * could fit so the message tells the administrator what to do. `budgetBytes` shrinks on retries.
 */
export function planEncode(probe: Probe, budgetBytes = TARGET_BYTES): Plan {
  const view = displaySize(probe);
  const fps = Math.min(probe.fps, MAX_FPS);
  const audioBps = probe.audioCodec ? (probe.duration > 60 ? AUDIO_BPS_LOW : AUDIO_BPS) : 0;
  const videoBps = videoBitrate(probe.duration, audioBps, budgetBytes);
  const rungs = ladderFor(view.width, view.height);
  // Never spend more bits than the source had: re-encoding a small file must not make it bigger. (H.264 holds the same quality at roughly 80% of
  // an older codec's bitrate.) The cap never goes below roughly half of what the chosen resolution needs to look acceptable.
  const sourceBps = (probe.sizeBytes * 8) / probe.duration;
  for (const rung of rungs) {
    const floor = minBitrateFor(rung.width, rung.height, fps);
    if (videoBps >= floor) return { ok: true, rung, fps, videoBps: Math.min(videoBps, Math.max(Math.floor(sourceBps * 0.8), Math.ceil(floor * 0.55))), audioBps };
  }
  const smallest = rungs[rungs.length - 1];
  const floorBps = minBitrateFor(smallest.width, smallest.height, fps);
  const maxSeconds = Math.floor((budgetBytes * 8 * 0.98) / (floorBps + audioBps));
  return { ok: false, maxSeconds };
}

/** A source we can simply re-wrap into MP4 without re-encoding: H.264 8-bit 4:2:0, AAC (or no) audio, sane size and frame rate. */
export const canRemux = (probe: Probe) =>
  probe.videoCodec === 'h264' && probe.pixelFormat === 'yuv420p' && (probe.audioCodec === null || probe.audioCodec === 'aac') &&
  displaySize(probe).height <= MAX_HEIGHT && probe.fps <= 60 && probe.rotation === 0 && probe.sizeBytes <= FINAL_MAX_BYTES;

/** Next bitrate budget after an attempt came out at `actualBytes`: scale by the miss and add a safety margin. */
export const nextBudget = (budgetBytes: number, actualBytes: number) => Math.floor(budgetBytes * (TARGET_BYTES / actualBytes) * 0.93);

export const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;


// ───────────────────────────── optimisation modes (admin choice) ─────────────────────────────

export type OptimizeMode = 'original' | 'balanced' | 'small';
export const OPTIMIZE_MODES: readonly OptimizeMode[] = ['original', 'balanced', 'small'];
export const DEFAULT_OPTIMIZE_MODE: OptimizeMode = 'original';
export const MODE_LABEL: Record<OptimizeMode, string> = { original: 'Original Quality', balanced: 'Auto Compress — Balanced', small: 'Auto Compress — Smaller Size' };
export const isOptimizeMode = (value: unknown): value is OptimizeMode => OPTIMIZE_MODES.includes(value as OptimizeMode);

export type Compat = { ok: true; container: 'mp4' | 'webm' } | { ok: false; reason: string };

/**
 * Can browsers play this file as it is (after at most a lossless re-wrap)? Judged from the REAL codecs, never from the file name:
 *   MP4 / MOV family: H.264, 8-bit 4:2:0, AAC / MP3 / no audio, normal frame rate
 *   WebM / Matroska:  VP8 or VP9 8-bit 4:2:0, Opus / Vorbis / no audio
 */
export function browserCompat(probe: Probe): Compat {
  const mp4Family = probe.formatNames.includes('mp4') || probe.formatNames.includes('mov');
  const webmFamily = probe.formatNames.includes('webm') || probe.formatNames.includes('matroska');
  if (probe.pixelFormat !== 'yuv420p') return { ok: false, reason: `${probe.pixelFormat || 'this pixel format'} (for example 10-bit or HDR) is not supported by most browsers` };
  if (mp4Family && probe.videoCodec === 'h264') {
    if (probe.audioCodec !== null && !['aac', 'mp3'].includes(probe.audioCodec)) return { ok: false, reason: `${probe.audioCodec} audio is not supported inside MP4` };
    if (probe.fps > 60.5) return { ok: false, reason: 'the frame rate is above 60 fps' };
    return { ok: true, container: 'mp4' };
  }
  if (webmFamily && (probe.videoCodec === 'vp8' || probe.videoCodec === 'vp9')) {
    if (probe.audioCodec !== null && !['opus', 'vorbis'].includes(probe.audioCodec)) return { ok: false, reason: `${probe.audioCodec} audio is not supported inside WebM` };
    return { ok: true, container: 'webm' };
  }
  return { ok: false, reason: `${probe.videoCodec ? probe.videoCodec.toUpperCase() : 'this video codec'} in a ${probe.formatNames[0] ?? 'this'} container is not reliably playable in browsers` };
}

export type QualityPlan = { crf: number; preset: 'veryfast' | 'faster'; maxHeight: number | null; maxFps: number | null; maxrateBps: number | null; audioBps: number; explain: string };

/** Total (container) bitrate of the source in bits per second. */
export const sourceBitrate = (probe: Probe) => (probe.sizeBytes * 8) / probe.duration;

/**
 * How to encode when a conversion or compression is wanted.
 *  original: visually lossless H.264 (CRF 17), source resolution and frame rate untouched (only used when the codec must change)
 *  balanced: CRF 22, never scales (8K is limited to 4K), never spends more than ~80% of the source bitrate
 *  small:    CRF 28, at most 1080p and 30 fps, never spends more than ~45% of the source bitrate
 */
export function qualityPlan(probe: Probe, mode: OptimizeMode): QualityPlan {
  const src = sourceBitrate(probe);
  const view = displaySize(probe);
  // HEVC, VP9 and AV1 need roughly half the bits of H.264 for the same picture, so a conversion from them may use up to ~2x the source bitrate; older codecs ~1.3x.
  // The ceiling stops a near-lossless conversion from ballooning (a 20 MB phone clip must not become 90 MB).
  if (mode === 'original') return { crf: 17, preset: 'veryfast', maxHeight: null, maxFps: null, maxrateBps: Math.floor(src * (['hevc', 'av1', 'vp9'].includes(probe.videoCodec) ? 2 : 1.3)), audioBps: 192_000, explain: 'Converted to H.264 at near-lossless quality (CRF 17, bitrate bounded by the source); resolution and frame rate are unchanged.' };
  if (mode === 'balanced') return { crf: 22, preset: 'veryfast', maxHeight: view.height > 2160 ? 2160 : null, maxFps: null, maxrateBps: Math.floor(src * 0.8), audioBps: 160_000, explain: 'Re-encoded with H.264 (CRF 22) at the original resolution and frame rate.' };
  return { crf: 28, preset: 'faster', maxHeight: view.height > 1080 ? 1080 : null, maxFps: probe.fps > 30.5 ? 30 : null, maxrateBps: Math.floor(src * 0.45), audioBps: 128_000, explain: 'Re-encoded with stronger H.264 compression (CRF 28) for a smaller download.' };
}

export type QualityWarning = { level: 'info' | 'warning'; text: string };

/** Honest notes about what a conversion changed. Resolution is only mentioned when it really changed. */
export function qualityNotes(src: Pick<Probe, 'width' | 'height' | 'rotation' | 'fps' | 'hdr' | 'duration'>, out: { width: number; height: number; fps: number; bytes: number; audioBps: number }, mode: OptimizeMode): QualityWarning[] {
  const a = displaySize(src);
  const notes: QualityWarning[] = [];
  if (out.height < a.height - 1 || out.width < a.width - 1) notes.push({ level: out.height * out.width < a.height * a.width * 0.45 ? 'warning' : 'info', text: `Resolution reduced from ${a.width}×${a.height} to ${out.width}×${out.height}.` });
  if (out.fps < src.fps - 0.6) notes.push({ level: 'info', text: `Frame rate reduced from ${Math.round(src.fps)} to ${Math.round(out.fps)} fps.` });
  if (src.hdr) notes.push({ level: 'warning', text: 'This video uses HDR or 10-bit colour. It was converted to standard 8-bit colour, so colours may look slightly flatter than on your phone.' });
  const bpp = Math.max(0, (out.bytes * 8) / src.duration - out.audioBps) / (out.width * out.height * Math.max(1, out.fps));
  if (bpp < 0.045 && mode !== 'original') notes.push({ level: 'warning', text: 'The video was compressed heavily, so fine detail and fast motion may look softer. Choose "Balanced" or "Original Quality" for higher quality.' });
  return notes;
}
