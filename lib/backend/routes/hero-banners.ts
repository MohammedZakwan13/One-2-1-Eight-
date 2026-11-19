import 'server-only';
import { adminHeroOrderSchema, adminHeroSlideUpdateSchema, heroVideoSessionRequestSchema } from '@/lib/api/schemas';
import { requireAdmin } from '@/lib/backend/auth';
import {
  BANNER_BUCKET, HttpError, db, isStoragePath, isUuid, json, route, removeBannerVideos, removeStorageObjects, storedBannerVideo, storedImage, storedLuxeImage,
} from '@/lib/backend/core';
import type { Row } from '@/lib/backend/data';
import { heroDto } from '@/lib/backend/routes/storefront';
import { storeBannerVideo } from '@/lib/backend/banner-storage';
import { enqueueVideoFile, enqueueVideoJob, getVideoJob } from '@/lib/backend/video-jobs';
import { abortUploadSession, createUploadSession, getUploadSession, takeCompletedUpload, writeChunk } from '@/lib/backend/video-uploads';
import { VideoError, requireFfmpeg, videoConfig } from '@/lib/backend/video-transcode';
import { rm } from 'node:fs/promises';
import { DEFAULT_OPTIMIZE_MODE, MB, isOptimizeMode, type OptimizeMode } from '@/lib/video-plan';
import { inspectHeroVideo } from '@/lib/hero-media';

/**
 * Hero banner management (Admin → Homepage & banners). Any number of banners: there is no count limit here or in the database.
 *
 *   order  = hero_slides.sort_order, rewritten atomically by reorder_hero_slides() (migration 0010), never by the browser's array order
 *   drafts = `active = false` (never public); publishing = `active = true`
 *   media  = images in the existing `media` bucket, videos in `banner-media`; a file is only deleted when no banner references it any more
 *   edits  = optimistic: a save based on a stale `updatedAt` is refused with 409 instead of overwriting another admin's change
 */

const MIGRATION_HINT = 'Banner media needs database migration 0010, which has not been applied yet.';
const missingSchema = (error: { code?: string; message?: string } | null) => Boolean(error) && /does not exist|schema cache|PGRST20[24]|42703|42883/.test(`${error?.code ?? ''} ${error?.message ?? ''}`);
const fail = (error: { code?: string; message?: string }, what: string): never => {
  if (missingSchema(error)) throw new HttpError(503, 'migration_required', MIGRATION_HINT);
  console.error(`[backend] ${what} failed`, error.code, error.message);
  throw new HttpError(500, 'server_error', 'Something went wrong.');
};

type Input = ReturnType<typeof adminHeroSlideUpdateSchema.parse>;

const columns = (s: Input) => ({
  kicker: s.kicker, title: s.title, body: s.body, cta: s.cta, href: s.href, active: s.active,
  desktop_image: storedImage(s.desktopImage), mobile_image: storedImage(s.mobileImage),
  desktop_media_type: s.desktopMediaType, desktop_video: storedBannerVideo(s.desktopVideo),
  mobile_media_type: s.mobileMediaType, mobile_video: storedBannerVideo(s.mobileVideo),
  use_desktop_on_mobile: s.useDesktopOnMobile, alt_text: s.altText,
});

const COPY_COLUMNS = ['kicker', 'title', 'body', 'cta', 'href', 'desktop_image', 'mobile_image', 'desktop_media_type', 'desktop_video', 'mobile_media_type', 'mobile_video', 'use_desktop_on_mobile', 'alt_text'] as const;
const nonEmpty = (values: unknown[]) => values.filter((value): value is string => typeof value === 'string' && value !== '');
const mediaOf = (row: Row | null | undefined) => ({ images: nonEmpty([row?.desktop_image, row?.mobile_image]), videos: nonEmpty([row?.desktop_video, row?.mobile_video]) });

/** Deletes the given files from Storage unless some banner still points at them (a duplicated banner shares its media with the original). */
export async function releaseUnusedMedia(candidates: { images: string[]; videos: string[] }): Promise<void> {
  if (!candidates.images.length && !candidates.videos.length) return;
  const { data, error } = await db().from('hero_slides').select('desktop_image, mobile_image, desktop_video, mobile_video');
  if (error) { console.error('[backend] banner media check failed; nothing was deleted', error.code); return; }
  const used = new Set<string>();
  for (const row of (data ?? []) as Row[]) for (const path of [...mediaOf(row).images, ...mediaOf(row).videos]) used.add(path);
  // The homepage Luxe band may use a still too; if that cannot be determined, nothing is deleted.
  const luxe = await storedLuxeImage();
  if (!luxe.ok) { console.error('[backend] luxe image check failed; nothing was deleted'); return; }
  if (luxe.path) used.add(luxe.path);
  await removeStorageObjects(candidates.images.filter(path => !used.has(path)));
  await removeBannerVideos(candidates.videos.filter(path => !used.has(path)));
}

const loadSlide = async (id: string): Promise<Row> => {
  if (!isUuid(id)) throw new HttpError(404, 'not_found', 'Banner not found.');
  const { data, error } = await db().from('hero_slides').select('*').eq('id', id).maybeSingle();
  if (error) fail(error, 'banner load');
  if (!data) throw new HttpError(404, 'not_found', 'Banner not found.');
  return data as Row;
};

const nextOrder = async (): Promise<number> => {
  const { data, error } = await db().from('hero_slides').select('sort_order').order('sort_order', { ascending: false }).limit(1);
  if (error) fail(error, 'banner order');
  return Number(((data ?? [])[0] as Row | undefined)?.sort_order ?? 0) + 1;
};

const reorder = async (ids: string[]) => {
  const { error } = await db().rpc('reorder_hero_slides', { p_ids: ids });
  if (!error) return;
  if (/order_stale/.test(error.message ?? '')) throw new HttpError(409, 'order_changed', 'The banner list changed in another session. Refresh the page and try again.');
  fail(error, 'banner reorder');
};

// Registered before `/:id` so that "order" is never read as a banner id.
route('PUT', '/admin/content/hero-slides/order', async ctx => {
  await requireAdmin(ctx, 'content');
  const { ids } = await ctx.body(adminHeroOrderSchema);
  await reorder(ids);
  const { data, error } = await db().from('hero_slides').select('*').order('sort_order').order('id');
  if (error) fail(error, 'banner list');
  return { items: ((data ?? []) as Row[]).map(heroDto) };
});

route('POST', '/admin/content/hero-slides', async ctx => {
  await requireAdmin(ctx, 'content');
  const input = await ctx.body(adminHeroSlideUpdateSchema);
  const { data, error } = await db().from('hero_slides').insert({ ...columns(input), sort_order: await nextOrder() }).select('*').single();
  if (error) fail(error, 'banner create');
  return json(heroDto(data as Row), 201);
});

route('PUT', '/admin/content/hero-slides/:id', async ctx => {
  await requireAdmin(ctx, 'content');
  const input = await ctx.body(adminHeroSlideUpdateSchema);
  const old = await loadSlide(ctx.params.id);
  const stale = () => new HttpError(409, 'slide_changed', 'This banner was changed by someone else. Reload the page to see their version, then re-apply your edit.');
  if (input.expectedUpdatedAt && old.updated_at && input.expectedUpdatedAt !== old.updated_at) throw stale();
  let query = db().from('hero_slides').update({ ...columns(input), updated_at: new Date().toISOString() }).eq('id', ctx.params.id);
  if (old.updated_at) query = query.eq('updated_at', old.updated_at);
  const { data, error } = await query.select('*').maybeSingle();
  if (error) fail(error, 'banner update');
  if (!data) throw stale();
  const before = mediaOf(old);
  const after = mediaOf(data as Row);
  await releaseUnusedMedia({ images: before.images.filter(path => !after.images.includes(path)), videos: before.videos.filter(path => !after.videos.includes(path)) });
  return heroDto(data as Row);
});

route('DELETE', '/admin/content/hero-slides/:id', async ctx => {
  await requireAdmin(ctx, 'content');
  const old = await loadSlide(ctx.params.id);
  const { error } = await db().from('hero_slides').delete().eq('id', ctx.params.id);
  if (error) fail(error, 'banner delete');
  await releaseUnusedMedia(mediaOf(old));
  return null;
});

/** The copy starts as a hidden draft right after the original and shares its media files (they are only deleted when no banner uses them). */
route('POST', '/admin/content/hero-slides/:id/duplicate', async ctx => {
  await requireAdmin(ctx, 'content');
  const source = await loadSlide(ctx.params.id);
  const copy: Record<string, unknown> = { active: false, sort_order: await nextOrder() };
  for (const column of COPY_COLUMNS) if (source[column] !== undefined) copy[column] = source[column];
  const { data, error } = await db().from('hero_slides').insert(copy).select('*').single();
  if (error) fail(error, 'banner duplicate');
  const created = data as Row;
  const { data: all } = await db().from('hero_slides').select('id').order('sort_order').order('id');
  const ids = ((all ?? []) as Row[]).map(row => row.id as string).filter(id => id !== created.id);
  const at = ids.indexOf(source.id);
  if (at >= 0) {
    ids.splice(at + 1, 0, created.id);
    try { await reorder(ids); } catch (failure) { console.error('[backend] duplicate kept at the end of the list', failure instanceof HttpError ? failure.code : failure); }
  }
  const { data: fresh } = await db().from('hero_slides').select('*').eq('id', created.id).maybeSingle();
  return json(heroDto((fresh ?? created) as Row), 201);
});

// ───────────── banner video upload ─────────────

const VIDEO_PATH = /^banners\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(mp4|webm)$/;

/** Media processing is required: a missing FFmpeg is reported as exactly that, never as an old size or format rule. */
const ensureMedia = async () => {
  try { await requireFfmpeg(); } catch (error) {
    if (error instanceof VideoError) throw new HttpError(503, 'media_processing_unavailable', error.message);
    throw error;
  }
};
const accepted = (job: { id: string; status: string; stage: string; originalBytes: number; originalName: string }) =>
  json({ jobId: job.id, status: job.status, stage: job.stage, originalBytes: job.originalBytes, originalName: job.originalName }, 202);

/**
 * Single-request upload. The admin screen does NOT use it (it uses the chunked sessions below, which have no size cap); it remains for API
 * clients and is limited only by what one request can carry. Everything goes through the same conversion queue.
 */
const SINGLE_REQUEST_MAX = 95 * 1024 * 1024;
route('POST', '/admin/uploads/banner-video', async ctx => {
  await requireAdmin(ctx, 'content');
  await ensureMedia();
  const tooLarge = () => new HttpError(413, 'file_too_large', `A single request can carry at most ${MB(SINGLE_REQUEST_MAX)} (proxy and memory limits). Use the chunked upload (/admin/uploads/banner-video/sessions), which the admin screen uses, for larger videos.`);
  if (Number(ctx.req.headers.get('content-length') ?? 0) > SINGLE_REQUEST_MAX + 64 * 1024) throw tooLarge();
  let form: FormData;
  try { form = await ctx.req.formData(); } catch { throw new HttpError(400, 'invalid_upload', 'Send the video as multipart form data in a "file" field.'); }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'invalid_upload', 'Send the video as multipart form data in a "file" field.');
  if (file.size === 0) throw new HttpError(422, 'invalid_video', 'That file is empty.');
  if (file.size > SINGLE_REQUEST_MAX) throw tooLarge();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = inspectHeroVideo(bytes);
  // A compatible MP4 / WebM is stored exactly as it is (original quality) when the optimisation mode is the default and it fits the output safeguard.
  const mode = isOptimizeMode(form.get('mode')) ? (form.get('mode') as OptimizeMode) : DEFAULT_OPTIMIZE_MODE;
  if (mode === 'original' && verdict.ok && file.size <= videoConfig().maxOutputBytes && !verdict.video.warnings.some(w => /slow start|index/i.test(w))) {
    const stored = await storeBannerVideo(bytes, verdict.video.ext, verdict.video.mime);
    return json({ ...stored, warnings: verdict.video.warnings, originalBytes: file.size, processedBytes: file.size, converted: false }, 201);
  }
  return accepted(await enqueueVideoJob(bytes, file.name, mode));
});

// ── chunked, resumable uploads (no cap on the source size; see lib/backend/video-uploads.ts) ──
route('POST', '/admin/uploads/banner-video/sessions', async ctx => {
  const admin = await requireAdmin(ctx, 'content');
  await ensureMedia();
  const input = await ctx.body(heroVideoSessionRequestSchema);
  return json(await createUploadSession(admin.id, input.name, input.size, input.mode, input.key), 201);
});
route('GET', '/admin/uploads/banner-video/sessions/:id', async ctx => {
  const admin = await requireAdmin(ctx, 'content');
  return json(getUploadSession(ctx.params.id, admin.id), 200);
});
route('PUT', '/admin/uploads/banner-video/sessions/:id/chunk', async ctx => {
  const admin = await requireAdmin(ctx, 'content');
  const offset = Number(ctx.url.searchParams.get('offset'));
  return json(await writeChunk(ctx.params.id, admin.id, offset, new Uint8Array(await ctx.req.arrayBuffer())), 200);
});
route('POST', '/admin/uploads/banner-video/sessions/:id/complete', async ctx => {
  const admin = await requireAdmin(ctx, 'content');
  await ensureMedia();
  const done = await takeCompletedUpload(ctx.params.id, admin.id);
  try {
    const job = await enqueueVideoFile(done.file, done.name, done.size, done.mode);
    await rm(done.dir, { recursive: true, force: true }).catch(() => undefined);
    return accepted(job);
  } catch (error) {
    await rm(done.dir, { recursive: true, force: true }).catch(() => undefined); // never leave the finished upload behind
    throw error;
  }
});
route('DELETE', '/admin/uploads/banner-video/sessions/:id', async ctx => {
  const admin = await requireAdmin(ctx, 'content');
  await abortUploadSession(ctx.params.id, admin.id);
  return null;
});

route('GET', '/admin/uploads/banner-video/jobs/:id', async ctx => {
  await requireAdmin(ctx, 'content');
  const job = isUuid(ctx.params.id) ? getVideoJob(ctx.params.id) : null;
  if (!job) throw new HttpError(404, 'not_found', 'This video job was not found. It may have expired or the server restarted: please upload the video again.');
  return json(job, 200);
});

route('DELETE', '/admin/uploads/banner-video', async ctx => {
  await requireAdmin(ctx, 'content');
  const path = ctx.url.searchParams.get('path') ?? '';
  if (!VIDEO_PATH.test(path) || !isStoragePath(path)) throw new HttpError(422, 'validation_failed', 'Invalid upload path.');
  const { data, error } = await db().from('hero_slides').select('desktop_video, mobile_video');
  if (error) fail(error, 'video refs');
  if (((data ?? []) as Row[]).some(row => row.desktop_video === path || row.mobile_video === path)) throw new HttpError(409, 'image_in_use', 'That video is still used by a banner.');
  await removeBannerVideos([path]);
  return null;
});

/** Removes banner videos older than 24 h that no banner references (abandoned uploads). Returns how many were removed. */
export async function cleanupBannerVideos(): Promise<number> {
  const { data, error } = await db().from('hero_slides').select('desktop_video, mobile_video');
  if (error) return 0;
  const used = new Set<string>();
  for (const row of (data ?? []) as Row[]) for (const path of mediaOf(row).videos) used.add(path);
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const orphans: string[] = [];
  const walk = async (prefix: string): Promise<void> => {
    const { data: entries } = await db().storage.from(BANNER_BUCKET).list(prefix, { limit: 1000 });
    for (const entry of entries ?? []) {
      const full = `${prefix}/${entry.name}`;
      if (entry.id === null) await walk(full);
      else if (VIDEO_PATH.test(full) && !used.has(full) && Date.parse(entry.created_at ?? '') < cutoff) orphans.push(full);
    }
  };
  await walk('banners');
  for (let i = 0; i < orphans.length; i += 100) await removeBannerVideos(orphans.slice(i, i + 100));
  return orphans.length;
}
