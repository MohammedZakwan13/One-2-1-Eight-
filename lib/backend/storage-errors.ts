/**
 * Turns a Supabase Storage error into a specific, accurate, secret-free answer for the admin, instead of one generic "could not be stored".
 * Pure (no I/O) so every case is unit-tested. Storage error texts describe the file or the bucket, never credentials; anything that
 * looks like a token or key is still masked before it is shown or logged.
 */
export type StorageFailure = { message?: string; name?: string; status?: number | string; statusCode?: number | string; cause?: unknown };
export type StorageVerdict = { status: number; code: string; message: string; log: { status: string; name: string; text: string } };

const mask = (text: string) => text.replace(/eyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, '[token]').replace(/\b(?:sb_secret|sb_publishable|sk|re|whsec)_[\w-]{8,}/g, '[key]').replace(/\s+/g, ' ').trim();

export function classifyStorageError(failure: StorageFailure, ctx: { bucket: string; limitLabel: string }): StorageVerdict {
  const raw = [failure.message, (failure.cause as { code?: string; message?: string } | undefined)?.code, (failure.cause as { message?: string } | undefined)?.message].filter(Boolean).join(' ');
  const text = mask(raw);
  const status = Number(failure.statusCode ?? failure.status ?? 0);
  const log = { status: String(failure.statusCode ?? failure.status ?? ''), name: String(failure.name ?? ''), text: text.slice(0, 300) };
  const v = (httpStatus: number, code: string, message: string): StorageVerdict => ({ status: httpStatus, code, message, log });

  // A connection dropped part way through a big upload (reset / broken pipe) is what Storage does when it refuses the size: say so, not "DNS".
  if (/ECONNRESET|EPIPE|socket hang up|other side closed|UND_ERR_SOCKET/i.test(raw) && !status) {
    return v(502, 'storage_connection_dropped', `The connection to Supabase Storage was closed while the video was being sent (a network-level reset, not an answer from Supabase). Try again; if it keeps happening, check this server's connection and that the "${ctx.bucket}" bucket and the project-wide upload limit (Supabase → Storage → Settings) allow a ${ctx.limitLabel} file. Your published video was not changed.`);
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network/i.test(raw) && !status) {
    return v(503, 'storage_unreachable', 'This server could not reach Supabase Storage (network or DNS problem). Check the internet connection and that the Supabase URL in the server settings is correct, then try again.');
  }
  if (/bucket not found|related resource does not exist|no such bucket/i.test(raw) || (status === 404 && !/object/i.test(raw))) {
    return v(503, 'migration_required', `The storage bucket "${ctx.bucket}" does not exist in the Supabase project this server is connected to. Apply migration 0010 (or create that bucket as a public bucket) before uploading videos.`);
  }
  if (status === 413 || /exceeded the maximum allowed size|payload too large|entity too large|file size|too large/i.test(raw)) {
    return v(413, 'file_too_large', `Supabase Storage refused the file as too large. The "${ctx.bucket}" bucket limit or the project's global upload limit (Dashboard → Storage → Settings) is lower than the ${ctx.limitLabel} this screen allows.${ctx.bucket === 'banner-media' ? ' For banner videos, apply database migration 0013 (supabase/migrations/0013_banner_video_size_limit.sql), which raises the bucket limit, and check the project-wide upload limit (the free Supabase plan allows 50 MB per file).' : ''}`);
  }
  if (status === 415 || /mime type|content[- ]type|not supported|invalid.*type/i.test(raw)) {
    return v(422, 'unsupported_type', `The "${ctx.bucket}" bucket does not accept this file type. It must allow video/mp4 and video/webm (migration 0010 sets this).`);
  }
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|row[- ]level security|invalid (jwt|api key|signature)|jwt|apikey/i.test(raw)) {
    return v(502, 'storage_unauthorized', 'Supabase Storage rejected the server\'s credentials. Check that SUPABASE_SERVICE_ROLE_KEY in the server settings belongs to the same project as SUPABASE_URL.');
  }
  if (status === 409 || /already exists|duplicate/i.test(raw)) {
    return v(409, 'upload_conflict', 'A file with that name already exists. Please try the upload again.');
  }
  return v(502, 'upload_failed', `The video could not be stored. Supabase Storage said: “${text.slice(0, 160) || 'no details'}”${log.status ? ` (HTTP ${log.status})` : ''}.`);
}
