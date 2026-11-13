import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '@/lib/backend/core';
import { videoConfig } from '@/lib/backend/video-transcode';
import { DEFAULT_OPTIMIZE_MODE, type OptimizeMode } from '@/lib/video-plan';

/**
 * Chunked, resumable uploads for large banner source videos.
 *
 * The browser cuts the file into fixed-size chunks (default 8 MB) and sends them one after another; each chunk is written straight to a
 * temporary file on disk at its offset, so the server never holds a whole video in memory and no single request is large (this also keeps
 * every request far below any proxy body limit, e.g. Cloudflare's 100 MB). A dropped connection resumes from `received`, a repeated chunk is
 * harmless, and uploading the same file twice reuses the running session instead of filling the disk. There is NO application cap on the
 * source size: the only limit is the free disk space, and when that is not enough the error says so with the real numbers.
 */

type Session = { id: string; owner: string; key?: string; name: string; size: number; mode: OptimizeMode; received: number; dir: string; file: string; createdAt: number; updatedAt: number; chain: Promise<unknown> };
type Store = { sessions: Map<string, Session>; swept: boolean };
const g = globalThis as unknown as { __o218_video_sessions__?: Store };
const store = (): Store => (g.__o218_video_sessions__ ??= { sessions: new Map(), swept: false });

const MiB = 1024 * 1024;
const IDLE_MS = 2 * 3_600_000;
const sizeLabel = (bytes: number) => (bytes >= 1024 * MiB ? `${(bytes / 1024 / MiB).toFixed(1)} GB` : `${Math.round(bytes / MiB)} MB`);
const publicSession = (s: Session) => ({ uploadId: s.id, size: s.size, received: s.received, chunkBytes: videoConfig().chunkBytes, mode: s.mode });

async function expire(): Promise<void> {
  const { sessions } = store();
  for (const [id, s] of sessions) if (Date.now() - s.updatedAt > IDLE_MS) { sessions.delete(id); await rm(s.dir, { recursive: true, force: true }).catch(() => undefined); }
  if (store().swept) return;
  store().swept = true; // leftovers of a crashed process: upload folders nobody can resume any more
  const root = path.join(videoConfig().tmpDir, 'uploads');
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, name); const info = await stat(dir).catch(() => null);
    if (info && Date.now() - info.mtimeMs > IDLE_MS && !sessions.has(name)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const find = (id: string, owner: string): Session => {
  const s = store().sessions.get(id);
  if (!s || s.owner !== owner) throw new HttpError(404, 'not_found', 'This upload was not found. It may have expired: please choose the video again.');
  return s;
};

/** Starts (or, for the same file by the same admin, resumes) an upload. Refuses clearly when the server cannot hold the file. */
export async function createUploadSession(owner: string, name: string, size: number, mode: OptimizeMode = DEFAULT_OPTIMIZE_MODE, key?: string) {
  const config = videoConfig();
  await expire();
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(422, 'invalid_video', 'That file is empty.');
  if (config.maxSourceBytes > 0 && size > config.maxSourceBytes) throw new HttpError(413, 'file_too_large', `This server is configured to accept source videos up to ${sizeLabel(config.maxSourceBytes)} (HERO_VIDEO_MAX_SOURCE_MB). This file is ${sizeLabel(size)}.`);
  const { sessions } = store();
  for (const s of sessions.values()) if (s.owner === owner && s.name === name && s.size === size && s.key === key) { s.updatedAt = Date.now(); s.mode = mode; return publicSession(s); } // duplicate or resumed upload
  if (sessions.size >= config.maxSessions) throw new HttpError(429, 'video_busy', 'Other large videos are still being uploaded. Please wait a minute and try again.');
  await mkdir(path.join(config.tmpDir, 'uploads'), { recursive: true });
  const disk = await statfs(config.tmpDir).catch(() => null);
  // The raw file, the processed file and FFmpeg's working space, plus a safety margin for the rest of the server.
  const need = size * 3 + 1024 * MiB;
  if (disk && disk.bavail * disk.bsize < need) throw new HttpError(507, 'insufficient_storage', `The server does not have enough free disk space to process a ${sizeLabel(size)} video right now (needs about ${sizeLabel(need)}, ${sizeLabel(disk.bavail * disk.bsize)} free). Free some space on the server or upload a smaller video.`);
  const id = randomUUID();
  const dir = path.join(config.tmpDir, 'uploads', id);
  await mkdir(dir, { recursive: true });
  const handle = await open(path.join(dir, 'source.bin'), 'w'); await handle.close();
  const s: Session = { id, owner, key, name: name.slice(0, 120), size, mode, received: 0, dir, file: path.join(dir, 'source.bin'), createdAt: Date.now(), updatedAt: Date.now(), chain: Promise.resolve() };
  sessions.set(id, s);
  return publicSession(s);
}

export function getUploadSession(id: string, owner: string) { return publicSession(find(id, owner)); }

/** Writes one chunk at `offset`. A chunk the server already has is acknowledged without being written again (safe retries). */
export async function writeChunk(id: string, owner: string, offset: number, data: Uint8Array) {
  const s = find(id, owner);
  const run = async () => {
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(422, 'invalid_chunk', 'Invalid chunk position.');
    if (data.byteLength === 0 || data.byteLength > videoConfig().chunkBytes * 2) throw new HttpError(422, 'invalid_chunk', 'Invalid chunk size.');
    if (offset + data.byteLength <= s.received) return publicSession(s); // already stored: a retry
    if (offset !== s.received) throw new HttpError(409, 'offset_mismatch', `Resume from byte ${s.received}.`, { received: [String(s.received)] });
    if (offset + data.byteLength > s.size) throw new HttpError(422, 'invalid_chunk', 'More data than the declared file size.');
    const handle = await open(s.file, 'r+');
    try { await handle.write(data, 0, data.byteLength, offset); } finally { await handle.close(); }
    s.received += data.byteLength; s.updatedAt = Date.now();
    return publicSession(s);
  };
  const next = s.chain.then(run, run); s.chain = next.catch(() => undefined); // chunks of one upload are applied strictly in order
  return next;
}

/** Hands the finished file over (the session ends here; the caller owns the file now). */
export async function takeCompletedUpload(id: string, owner: string): Promise<{ file: string; name: string; size: number; dir: string; mode: OptimizeMode }> {
  const s = find(id, owner);
  await s.chain;
  if (s.received !== s.size) throw new HttpError(409, 'incomplete_upload', `Only ${sizeLabel(s.received)} of ${sizeLabel(s.size)} arrived. Resume the upload.`);
  const actual = (await stat(s.file)).size;
  if (actual !== s.size) throw new HttpError(409, 'incomplete_upload', 'The uploaded file is not complete. Please upload it again.');
  store().sessions.delete(id);
  return { file: s.file, name: s.name, size: s.size, dir: s.dir, mode: s.mode };
}

export async function abortUploadSession(id: string, owner: string): Promise<void> {
  const s = store().sessions.get(id);
  if (!s || s.owner !== owner) return;
  store().sessions.delete(id);
  await rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
}

export const resetUploadSessionsForTests = () => { g.__o218_video_sessions__ = undefined; };
