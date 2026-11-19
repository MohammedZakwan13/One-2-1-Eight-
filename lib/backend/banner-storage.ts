import 'server-only';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getServerEnv } from '@/lib/env';
import { BANNER_BUCKET, HttpError, bannerVideoUrl, db, removeBannerVideos } from '@/lib/backend/core';
import { classifyStorageError, type StorageFailure } from '@/lib/backend/storage-errors';
import { videoConfig } from '@/lib/backend/video-transcode';
import { LIMIT_LABEL, MB } from '@/lib/video-plan';

/**
 * Stores one finished banner video in the `banner-media` bucket and proves visitors can read it. Shared by the direct upload (a file that
 * is already a compatible MP4/WebM within 12 MB) and the background converter. Every call uses a brand-new path, so a failed or replaced
 * upload can never overwrite or delete a video a banner already uses.
 */
/**
 * Asks Storage (read only) what the bucket really allows BEFORE sending a large file. Supabase drops the connection of an oversize upload part
 * way through, which the client can only report as "fetch failed / ECONNRESET": that is not a DNS problem, and it must not be described as one.
 * Unknown (the lookup itself failing) never blocks an upload; only a definite "too large" or "type not allowed" does.
 */
async function assertBucketAccepts(size: number, mime: string): Promise<void> {
  // A lookup that does not answer quickly is treated as "unknown": it must never hold up the upload queue.
  const bucket = await withDeadline(Promise.resolve(db().storage.getBucket?.(BANNER_BUCKET)).then(r => r?.data ?? null, () => null), 15_000, null);
  if (!bucket) return;
  const limit = Number(bucket.file_size_limit ?? 0);
  if (limit > 0 && size > limit) {
    throw new HttpError(413, 'bucket_limit_too_small', `This video is ${MB(size)}, but the "${BANNER_BUCKET}" storage bucket currently accepts files of at most ${LIMIT_LABEL(limit)}. Apply database migration 0013 (raises the bucket to 50 MB, after checking the project-wide limit in Supabase → Storage → Settings), or choose Auto Compress for a smaller file. Your published video was not changed.`);
  }
  const types = bucket.allowed_mime_types;
  if (Array.isArray(types) && types.length > 0 && !types.includes(mime)) {
    throw new HttpError(422, 'unsupported_type', `The "${BANNER_BUCKET}" bucket does not accept ${mime}. It must allow video/mp4 and video/webm (migration 0010 sets this).`);
  }
}

/** The only final types the `banner-media` bucket accepts, by extension. A QuickTime MOV (ftyp brand "qt  ") is never one of them. */
const FINAL_TYPES = { mp4: 'video/mp4', webm: 'video/webm' } as const;

/**
 * Proves the processed file really is what it claims BEFORE anything is sent: the declared type is MP4 or WebM, and the first bytes of the file
 * are an ISO-BMFF `ftyp` box (not the QuickTime brand) for MP4, or an EBML header for WebM. A conversion that left a MOV behind is stopped here.
 */
export function assertFinalFormat(ext: string, mime: string, head: Uint8Array): void {
  if (!(ext in FINAL_TYPES) || FINAL_TYPES[ext as keyof typeof FINAL_TYPES] !== mime) {
    throw new HttpError(422, 'unsupported_type', `The processed video is ${mime || 'of an unknown type'} (.${ext}), but banner videos must be video/mp4 or video/webm. Nothing was uploaded.`);
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(head.subarray(from, to)));
  const isMp4 = head.length >= 12 && ascii(4, 8) === 'ftyp' && ascii(8, 12) !== 'qt  ';
  const isWebm = head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  if ((ext === 'mp4' && !isMp4) || (ext === 'webm' && !isWebm)) {
    throw new HttpError(422, 'verify_failed', `The processed file is not a valid ${ext.toUpperCase()} video (its header says otherwise), so it was not uploaded. Please try again or use another video.`);
  }
}

/** Resolves with `fallback` when `work` does not settle in time (the work is left to finish on its own). */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]).finally(() => clearTimeout(timer));
}

/** Longest a single Storage upload may take in total, and the longest it may make no progress at all (a dead connection). */
export const uploadLimits = (size: number) => {
  const kibPerSecond = Math.max(8, Number(process.env.HERO_VIDEO_UPLOAD_MIN_KBPS) || 32); // slowest link still accepted, in KiB/s
  return { totalMs: Math.min(60 * 60_000, 120_000 + Math.ceil(size / (kibPerSecond * 1024)) * 1000), idleMs: Math.max(5_000, Number(process.env.HERO_VIDEO_UPLOAD_IDLE_S) * 1000 || 120_000) };
};

const probeReadable = async (url: string, path: string) => {
  // The URL must really be readable by visitors (the bucket has to be public). Only a definite refusal counts; a network blip does not undo a good upload.
  const probe = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (probe && [401, 403, 404].includes(probe.status)) {
    await removeBannerVideos([path]);
    console.error('[backend] banner video stored but not publicly readable', probe.status);
    throw new HttpError(502, 'storage_unreadable', `The video was stored but visitors cannot read it (HTTP ${probe.status}). The "${BANNER_BUCKET}" bucket must be a public bucket. The upload was undone.`);
  }
};

/**
 * Stores a processed video that is a FILE on disk, streaming it to Storage (never held in memory) with real progress, a stall detector and an
 * overall deadline. A connection that stops moving is aborted after HERO_VIDEO_UPLOAD_IDLE_S seconds (default 120), so one dead connection can
 * never hold the job queue; a slow but steady link may take as long as its size needs (HERO_VIDEO_UPLOAD_MIN_KBPS, default 32 KiB/s).
 */
export async function storeBannerVideoFile(file: string, size: number, ext: 'mp4' | 'webm', mime: string, onProgress?: (percent: number) => void): Promise<{ path: string; url: string }> {
  const limit = videoConfig().maxOutputBytes;
  if (size === 0 || size > limit) throw new HttpError(413, 'file_too_large', `This video is ${MB(size)}, above this server's ${LIMIT_LABEL(limit)} limit for banner videos (HERO_VIDEO_MAX_OUTPUT_MB).`);
  const handle = await open(file, 'r');
  try { const head = new Uint8Array(16); const { bytesRead } = await handle.read(head, 0, 16, 0); assertFinalFormat(ext, mime, head.subarray(0, bytesRead)); } finally { await handle.close(); }
  await assertBucketAccepts(size, mime);
  const now = new Date();
  const path = `banners/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
  const { supabase } = getServerEnv();
  if (!supabase) throw new HttpError(503, 'storage_unconfigured', 'Supabase Storage is not configured on this server.');
  const { totalMs, idleMs } = uploadLimits(size);
  const controller = new AbortController();
  let sent = 0; let lastMove = Date.now(); let lastReported = -1; let reason = '';
  const abort = (why: string) => { reason = why; controller.abort(); };
  const total = setTimeout(() => abort('total'), totalMs);
  const watchdog = setInterval(() => { if (Date.now() - lastMove > idleMs) abort('stalled'); }, 1000);
  const counted = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, out) { sent += chunk.byteLength; lastMove = Date.now(); const pct = Math.min(99, Math.floor((sent / size) * 100)); if (pct !== lastReported) { lastReported = pct; onProgress?.(pct); } out.enqueue(chunk); } });
  const body = (Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>).pipeThrough(counted);
  try {
    const response = await fetch(`${supabase.url}/storage/v1/object/${BANNER_BUCKET}/${path}`, {
      method: 'POST', signal: controller.signal, duplex: 'half', body,
      headers: { apikey: supabase.serviceRoleKey, authorization: `Bearer ${supabase.serviceRoleKey}`, 'content-type': mime, 'content-length': String(size), 'cache-control': 'max-age=31536000', 'x-upsert': 'false' },
    } as RequestInit);
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { message?: string; error?: string; statusCode?: string | number };
      const failure = classifyStorageError({ message: detail.message ?? detail.error ?? `HTTP ${response.status}`, status: response.status, statusCode: detail.statusCode }, { bucket: BANNER_BUCKET, limitLabel: LIMIT_LABEL(limit) });
      console.error('[backend] banner video upload failed', failure.log);
      throw new HttpError(failure.status, failure.code, failure.message);
    }
    onProgress?.(100);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Anything cancelled or dropped part way: make sure no half-stored object can remain, then explain what happened.
    await removeBannerVideos([path]).catch(() => undefined);
    if (reason) {
      console.error('[backend] banner video upload aborted', { reason, sentBytes: sent, size });
      throw new HttpError(504, 'storage_timeout', reason === 'stalled'
        ? `Uploading the processed video to Supabase Storage stopped making progress (${MB(sent)} of ${MB(size)} sent). Check this server's internet connection and try again. Your published video was not changed.`
        : `Uploading the processed video to Supabase Storage took too long (${MB(sent)} of ${MB(size)} sent). The connection from this server to Supabase is too slow for a ${MB(size)} video; use Auto Compress for a smaller file or try again later. Your published video was not changed.`);
    }
    const failure = classifyStorageError({ message: error instanceof Error ? error.message : String(error), cause: (error as { cause?: unknown }).cause }, { bucket: BANNER_BUCKET, limitLabel: LIMIT_LABEL(limit) });
    console.error('[backend] banner video upload failed', failure.log);
    throw new HttpError(failure.status, failure.code, failure.message);
  } finally { clearTimeout(total); clearInterval(watchdog); }
  const url = bannerVideoUrl(path);
  await probeReadable(url, path);
  return { path, url };
}

export async function storeBannerVideo(bytes: Uint8Array, ext: 'mp4' | 'webm', mime: string): Promise<{ path: string; url: string }> {
  const limit = videoConfig().maxOutputBytes; // the effective output limit (default 45,000,000 bytes, HERO_VIDEO_MAX_OUTPUT_MB): checked here, before anything is sent to Storage
  if (bytes.byteLength === 0 || bytes.byteLength > limit) throw new HttpError(413, 'file_too_large', `This video is ${MB(bytes.byteLength)}, above this server's ${LIMIT_LABEL(limit)} limit for banner videos (HERO_VIDEO_MAX_OUTPUT_MB).`);
  assertFinalFormat(ext, mime, bytes.subarray(0, 16));
  await assertBucketAccepts(bytes.byteLength, mime);
  const now = new Date();
  const path = `banners/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${ext}`;
  const attempt = Promise.resolve(db().storage.from(BANNER_BUCKET).upload(path, bytes, { contentType: mime, cacheControl: '31536000', upsert: false }));
  const settled = await withDeadline(attempt, uploadLimits(bytes.byteLength).totalMs, null);
  if (settled === null) void attempt.then(late => { if (!late.error) void removeBannerVideos([path]); }, () => undefined); // an abandoned upload that finishes later is removed, never left behind
  const error = settled ? settled.error : ({ message: 'upload timed out', name: 'StorageTimeout', status: 504 } as unknown as StorageFailure);
  if (error) {
    const failure = classifyStorageError(error as StorageFailure, { bucket: BANNER_BUCKET, limitLabel: LIMIT_LABEL(limit) });
    console.error('[backend] banner video upload failed', failure.log);
    throw new HttpError(failure.status, failure.code, failure.message);
  }
  const url = bannerVideoUrl(path);
  await probeReadable(url, path);
  return { path, url };
}
