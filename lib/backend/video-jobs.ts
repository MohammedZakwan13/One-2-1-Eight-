import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storeBannerVideoFile, uploadLimits } from '@/lib/backend/banner-storage';
import { HttpError } from '@/lib/backend/core';
import { DEFAULT_OPTIMIZE_MODE, type OptimizeMode } from '@/lib/video-plan';
import { VideoError, processVideo, requireFfmpeg, videoConfig, type VideoInfo, type VideoResult, type VideoStage } from '@/lib/backend/video-transcode';

/**
 * Background conversion of uploaded banner videos, sized for a 1-vCPU VPS:
 *   - at most `maxConcurrent` encodes run at once (default 1), and at most `maxQueued` jobs wait, so a burst of uploads is refused with
 *     a clear "busy" message instead of piling up work or disk;
 *   - the raw upload is written to a private temp folder, the disk is checked first, and the folder is deleted when the job ends in any way;
 *   - nothing reaches permanent storage until the processed file has been verified (see video-transcode.ts), so a failed job leaves no
 *     storage object and no database record (jobs live only in memory and expire after an hour).
 * Jobs are kept in this process only. A restart loses in-flight jobs; the admin then sees "not found" and simply uploads again.
 */

export type JobStatus = 'queued' | 'processing' | 'ready' | 'failed';
/** `uploading` = the processed file is being sent to Supabase Storage (real progress in `percent`). */
export type JobStage = 'queued' | VideoStage | 'uploading';
export type VideoJob = {
  id: string; status: JobStatus; stage: JobStage; percent: number; originalName: string; originalBytes: number;
  mode: OptimizeMode; processedBytes?: number; path?: string; url?: string; width?: number; height?: number; durationSeconds?: number; converted?: boolean; info?: VideoInfo; processingMs?: number;
  warnings: string[]; error?: { code: string; message: string }; createdAt: number; updatedAt: number;
  /** Queued jobs only: how many videos are ahead (being processed or waiting), so the admin sees a real position, not an open-ended wait. */
  ahead?: number;
};
type Internal = VideoJob & { dir: string; input: string; slotHeld?: boolean; reaped?: boolean };
type State = { jobs: Map<string, Internal>; queue: string[]; active: number; swept: boolean };
const g = globalThis as unknown as { __o218_video_jobs__?: State };
const state = (): State => (g.__o218_video_jobs__ ??= { jobs: new Map(), queue: [], active: 0, swept: false });

const HOUR = 3_600_000;
const publicJob = ({ dir: _dir, input: _input, slotHeld: _slot, reaped: _reaped, ...job }: Internal): VideoJob => ({ ...job, ...(job.status === 'queued' ? { ahead: state().active + Math.max(0, state().queue.indexOf(job.id)) } : {}) });

/** Removes leftovers of a crashed run (folders older than two hours) once per process start. */
async function sweepStale(): Promise<void> {
  const s = state(); if (s.swept) return; s.swept = true;
  const root = videoConfig().tmpDir;
  const entries = await readdir(root).catch(() => [] as string[]);
  await Promise.all(entries.map(async name => { const dir = path.join(root, name); const info = await stat(dir).catch(() => null); if (info && Date.now() - info.mtimeMs > 2 * HOUR) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }));
}

function purgeOld(): void {
  const s = state();
  for (const [id, job] of s.jobs) if (job.status !== 'queued' && job.status !== 'processing' && Date.now() - job.updatedAt > HOUR) s.jobs.delete(id);
}

const touch = (job: Internal, patch: Partial<Internal>) => { Object.assign(job, patch, { updatedAt: Date.now() }); };
const messageOf = (error: unknown): { code: string; message: string } => {
  if (error instanceof VideoError) return { code: error.code, message: error.message };
  if (error instanceof HttpError) return { code: error.code, message: error.message };
  console.error('[video] unexpected failure', error instanceof Error ? error.message : error);
  return { code: 'server_error', message: 'The video could not be processed. Please try again.' };
};

/** Frees the encoder slot exactly once, whatever happens (finished, failed, or reaped as stuck), and lets the next video start. */
function releaseSlot(job: Internal): void {
  if (!job.slotHeld) return;
  job.slotHeld = false;
  const s = state(); s.active = Math.max(0, s.active - 1);
  pump();
}

const finishFailed = (job: Internal, error: unknown, started: number) => {
  if (job.reaped) return; // the watchdog already reported this job as stalled
  touch(job, { status: 'failed', error: messageOf(error), processingMs: Date.now() - started });
  // eslint-disable-next-line no-console -- one structured line per job, for monitoring processing time, storage and bandwidth
  console.info(`[video] job failed mode=${job.mode} in=${job.originalBytes}B took=${Date.now() - started}ms stage=${job.stage} code=${job.error?.code}`);
};

async function runJob(job: Internal): Promise<void> {
  const started = Date.now();
  try {
    touch(job, { status: 'processing', stage: 'analyzing', percent: 0 });
    await requireFfmpeg();
    const result: VideoResult = await processVideo(job.input, job.dir, { mode: job.mode, onStage: (stage, percent) => touch(job, { stage, percent }) });
    // Encoding is finished: free the encoder at once. Sending the result to Storage is network time and must never hold up the next video.
    releaseSlot(job);
    touch(job, { stage: 'uploading', percent: 0 });
    let last = -1;
    const stored = await storeBannerVideoFile(result.path, result.bytes, result.ext, result.mime, percent => { if (percent !== last) { last = percent; touch(job, { stage: 'uploading', percent }); } });
    if (job.reaped) return;
    const processingMs = Date.now() - started;
    touch(job, { status: 'ready', stage: 'uploading', percent: 100, processedBytes: result.bytes, path: stored.path, url: stored.url, width: result.width, height: result.height, durationSeconds: result.duration, converted: !result.info.preserved, info: result.info, processingMs, warnings: result.warnings });
    // One structured line per job: processing time, sizes and what happened, for monitoring storage, bandwidth and CPU use.
    // eslint-disable-next-line no-console -- one structured line per job, for monitoring processing time, storage and bandwidth
    console.info(`[video] job ready mode=${job.mode} action=${result.info.action} resized=${result.info.resized} in=${job.originalBytes}B out=${result.bytes}B ${result.info.original.width}x${result.info.original.height}->${result.width}x${result.height} took=${processingMs}ms`);
  } catch (error) {
    finishFailed(job, error, started);
  } finally {
    releaseSlot(job);
    await rm(job.dir, { recursive: true, force: true }).catch(() => undefined); // raw upload and output are always removed
  }
}

/**
 * Safety net: a job that has not reported ANY progress for far longer than any step can take is failed and its slot freed, so nothing can
 * block the queue for ever (this also heals a job left in a non-final state by an earlier version of this process). Encoding reports progress
 * continuously and an upload reports every percent, so a quiet job is genuinely stuck.
 */
function reapStuck(): void {
  const s = state(); const now = Date.now();
  for (const job of s.jobs.values()) {
    if (job.status !== 'processing') continue;
    const limit = job.stage === 'uploading' ? uploadLimits(job.processedBytes ?? videoConfig().maxOutputBytes).idleMs + 5 * 60_000 : Math.max(15 * 60_000, videoConfig().jobTimeoutMs * 2);
    if (now - job.updatedAt <= limit) continue;
    job.reaped = true;
    touch(job, { status: 'failed', error: { code: 'stalled', message: `The video stopped making progress while ${job.stage === 'uploading' ? 'it was being uploaded to Supabase Storage' : 'it was being processed'}, so it was cancelled. Your published video was not changed. Please try again.` } });
    // eslint-disable-next-line no-console -- watchdog report
    console.info(`[video] job reaped as stalled stage=${job.stage} idleMs=${now - job.updatedAt}`);
    void rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    if (job.slotHeld === undefined) job.slotHeld = true; // a job created by an earlier version of this process: it held a slot
    releaseSlot(job);
  }
}

function pump(): void {
  const s = state();
  reapStuck();
  if (s.active < 0) s.active = 0;
  while (s.active < videoConfig().maxConcurrent && s.queue.length > 0) {
    const job = s.jobs.get(s.queue.shift()!);
    if (!job) continue;
    s.active += 1; job.slotHeld = true;
    void runJob(job);
  }
}

function checkCapacity(): void {
  const config = videoConfig(); const s = state();
  reapStuck();
  purgeOld();
  if (s.queue.length + s.active >= config.maxQueued + config.maxConcurrent) throw new HttpError(429, 'video_busy', 'Other videos are still being processed. Please wait a minute and try again.');
}

function register(id: string, dir: string, input: string, name: string, size: number, mode: OptimizeMode): VideoJob {
  const job: Internal = { id, mode, status: 'queued', stage: 'queued', percent: 0, originalName: name.slice(0, 120), originalBytes: size, warnings: [], createdAt: Date.now(), updatedAt: Date.now(), dir, input };
  const s = state(); s.jobs.set(id, job); s.queue.push(id);
  pump();
  return publicJob(job);
}

/**
 * Queues a source file that is already on disk (a finished chunked upload). The file is moved, not copied, so even a very large video is
 * never read into memory or written twice. The job owns it from here and deletes it when it ends.
 */
export async function enqueueVideoFile(file: string, originalName: string, size: number, mode: OptimizeMode = DEFAULT_OPTIMIZE_MODE): Promise<VideoJob> {
  checkCapacity();
  await sweepStale();
  const id = randomUUID();
  const dir = path.join(videoConfig().tmpDir, id);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, 'input.bin'); // a fixed name: the uploaded file name never touches the file system
  try { await rename(file, input); } catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => undefined); throw error; }
  return register(id, dir, input, originalName, size, mode);
}

/** Queues an upload that arrived whole in one request (the legacy single-request endpoint; bounded by the request size). */
export async function enqueueVideoJob(bytes: Uint8Array, originalName: string, mode: OptimizeMode = DEFAULT_OPTIMIZE_MODE): Promise<VideoJob> {
  const config = videoConfig();
  checkCapacity();
  await sweepStale();
  await mkdir(config.tmpDir, { recursive: true });
  const disk = await statfs(config.tmpDir).catch(() => null);
  if (disk && disk.bavail * disk.bsize < bytes.byteLength * 3 + 512 * 1024 * 1024) throw new HttpError(507, 'insufficient_storage', 'The server is low on temporary disk space, so this video cannot be processed right now. Please try again later.');
  const id = randomUUID();
  const dir = path.join(config.tmpDir, id);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, 'input.bin');
  try { await writeFile(input, bytes); } catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => undefined); throw error; }
  return register(id, dir, input, originalName, bytes.byteLength, mode);
}

export const getVideoJob = (id: string): VideoJob | null => { reapStuck(); const job = state().jobs.get(id); return job ? publicJob(job) : null; };
export const resetVideoJobsForTests = () => { g.__o218_video_jobs__ = undefined; };
