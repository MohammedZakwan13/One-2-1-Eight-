import 'server-only';
import { randomUUID } from 'node:crypto';
import { adminHeroOrderSchema, adminHeroSlideUpdateSchema } from '@/lib/api/schemas';
import { requireAdmin } from '@/lib/backend/auth';
import {
  BANNER_BUCKET, HttpError, bannerVideoUrl, db, isStoragePath, isUuid, json, route, removeBannerVideos, removeStorageObjects, storedBannerVideo, storedImage, storedLuxeImage,
} from '@/lib/backend/core';
import type { Row } from '@/lib/backend/data';
import { heroDto } from '@/lib/backend/routes/storefront';
import { classifyStorageError, type StorageFailure } from '@/lib/backend/storage-errors';
import { HERO_VIDEO_MAX_BYTES, HERO_VIDEO_MAX_LABEL, inspectHeroVideo } from '@/lib/hero-media';

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

route('POST', '/admin/uploads/banner-video', async ctx => {
  await requireAdmin(ctx, 'content');
  const tooLarge = () => new HttpError(413, 'file_too_large', `Videos must be ${HERO_VIDEO_MAX_LABEL} or smaller. Compress it or shorten the clip first.`);
  if (Number(ctx.req.headers.get('content-length') ?? 0) > HERO_VIDEO_MAX_BYTES + 64 * 1024) throw tooLarge();
  let form: FormData;
  try { form = await ctx.req.formData(); } catch { throw new HttpError(400, 'invalid_upload', 'Send the video as multipart form data in a "file" field.'); }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'invalid_upload', 'Send the video as multipart form data in a "file" field.');
  if (file.size === 0) throw new HttpError(422, 'invalid_video', 'That file is empty.');
  if (file.size > HERO_VIDEO_MAX_BYTES) throw tooLarge();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = inspectHeroVideo(bytes);
  if (!verdict.ok) {
    const code = verdict.error.reason === 'unrecognised' ? 'invalid_video' : verdict.error.reason;
    throw new HttpError(422, code, verdict.error.message);
  }
  const now = new Date();
  const path = `banners/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${verdict.video.ext}`;
  // Every upload gets a brand-new path, so a failed or replaced upload can never overwrite or delete the video a banner already uses.
  const { error } = await db().storage.from(BANNER_BUCKET).upload(path, bytes, { contentType: verdict.video.mime, cacheControl: '31536000', upsert: false });
  if (error) {
    const failure = classifyStorageError(error as StorageFailure, { bucket: BANNER_BUCKET, limitLabel: HERO_VIDEO_MAX_LABEL });
    console.error('[backend] banner video upload failed', failure.log);
    throw new HttpError(failure.status, failure.code, failure.message);
  }
  const url = bannerVideoUrl(path);
  // The URL must really be readable by visitors (the bucket has to be public). Only a definite refusal counts; a network blip does not undo a good upload.
  const probe = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (probe && [401, 403, 404].includes(probe.status)) {
    await removeBannerVideos([path]);
    console.error('[backend] banner video stored but not publicly readable', probe.status);
    throw new HttpError(502, 'storage_unreadable', `The video was stored but visitors cannot read it (HTTP ${probe.status}). The "${BANNER_BUCKET}" bucket must be a public bucket. The upload was undone.`);
  }
  return json({ path, url, warnings: verdict.video.warnings }, 201);
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
