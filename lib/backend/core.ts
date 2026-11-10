import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getServerEnv } from '@/lib/env';
import { UNVERIFIED_IP } from '@/lib/backend/client-ip';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fieldErrors?: Record<string, string[]>) {
    super(message);
  }
}

// ───────────── database ─────────────

type Db = SupabaseClient;
const GLOBAL_KEY = '__o218_supabase__';
type Holder = typeof globalThis & { [GLOBAL_KEY]?: { service: Db; anon: Db } };

function clients() {
  const holder = globalThis as Holder;
  if (!holder[GLOBAL_KEY]) {
    const { supabase } = getServerEnv();
    if (!supabase) throw new HttpError(503, 'backend_unconfigured', 'The store backend is not configured.');
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    holder[GLOBAL_KEY] = { service: createClient(supabase.url, supabase.serviceRoleKey, options), anon: createClient(supabase.url, supabase.anonKey, options) };
  }
  return holder[GLOBAL_KEY]!;
}
/** Privileged server-side client. Bypasses RLS: every caller must enforce authorisation itself. */
export const db = (): Db => clients().service;
/** Used only to verify admin passwords through Supabase Auth. */
export const authClient = (): Db => clients().anon;

/** Unwraps a Supabase result; unexpected database errors become a logged 500 with no internals exposed. */
export function must<T>(result: { data: T | null; error: { message: string; code?: string } | null }, what = 'query'): T {
  if (result.error) {
    console.error(`[backend] ${what} failed`, result.error.code, result.error.message);
    throw new HttpError(500, 'server_error', 'Something went wrong.');
  }
  return result.data as T;
}
export const isUnique = (error: { code?: string; message?: string } | null, hint?: string) =>
  error?.code === '23505' && (!hint || (error.message ?? '').includes(hint));

// ───────────── crypto helpers ─────────────

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = (bytes = 32) => randomBytes(bytes).toString('hex');
export const safeEqual = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
/**
 * Per-order tracking token for emailed links: HMAC of the order id under a server-only key, so it can be rebuilt for any later
 * email (the one-time `lookupToken` is only stored hashed) and cannot be guessed from the order number or id.
 */
export const trackingToken = (orderId: string) => createHmac('sha256', getServerEnv().supabase?.serviceRoleKey ?? 'unconfigured').update(`track:${orderId}`).digest('hex');
export const trackingUrl = (orderId: string) => `${getServerEnv().siteUrl}/order-confirmation?order=${orderId}&token=${trackingToken(orderId)}`;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// ───────────── routing ─────────────

export const COOKIES = { csrf: 'o218_csrf', cart: 'o218_cart', customer: 'o218_session' } as const;

export type Ctx = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  cookies: Record<string, string>;
  ip: string;
  setCookie: (name: string, value: string, maxAgeSeconds?: number) => void;
  body: <S extends z.ZodType>(schema: S) => Promise<z.infer<S>>;
};
type Result = Response | object | null | undefined;
type Handler = (ctx: Ctx) => Result | Promise<Result>;
type Route = { method: string; pattern: string; regex: RegExp; keys: string[]; handler: Handler; csrf: boolean };

const routes: Route[] = [];
export function route(method: string, pattern: string, handler: Handler, options: { csrf?: boolean } = {}) {
  const keys: string[] = [];
  const source = pattern.replace(/\/:([A-Za-z]+)/g, (_m, key: string) => { keys.push(key); return '/([^/]+)'; });
  routes.push({ method, pattern, handler, regex: new RegExp(`^${source}$`), keys, csrf: options.csrf ?? method !== 'GET' });
}
export const backendRoutes = () => routes.map(item => ({ method: item.method, path: item.pattern }));

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const parseCookies = (header: string | null) => {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) { try { out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* ignore malformed cookie */ } }
  }
  return out;
};

export const pageParams = (url: URL, defaultSize = 48) => ({
  page: Math.max(1, Math.floor(Number(url.searchParams.get('page'))) || 1),
  pageSize: Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize'))) || defaultSize)),
});

/** Escapes a CSV cell and neutralises spreadsheet formula injection (=, +, -, @). */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export const csv = (filename: string, rows: unknown[][]) =>
  new Response(rows.map(row => row.map(csvCell).join(',')).join('\r\n'), {
    status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
  });

/** Fixed-window throttle backed by the database so it holds across serverless instances. */
/** Seconds until a full rate-limit window frees one slot: `newestFirst` holds the newest `max` event times of the window. Never less than 1. */
export function retryAfterSeconds(newestFirst: string[], windowSeconds: number, now = Date.now()): number {
  const oldestCounted = Date.parse(newestFirst[newestFirst.length - 1] ?? '');
  if (Number.isNaN(oldestCounted)) return windowSeconds;
  return Math.min(windowSeconds, Math.max(1, Math.ceil((oldestCounted + windowSeconds * 1000 - now) / 1000)));
}
export function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export async function rateLimit(bucket: string, max: number, windowSeconds: number, message = 'Too many attempts. Please try again later.') {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count, error } = await db().from('rate_events').select('id', { count: 'exact', head: true }).eq('bucket', bucket).gte('created_at', since);
  if (error) throw new HttpError(500, 'server_error', 'Something went wrong.');
  if ((count ?? 0) >= max) {
    // The slot that frees first is the oldest of the newest `max` events; report how long until then (a duration only, nothing identifying).
    const { data } = await db().from('rate_events').select('created_at').eq('bucket', bucket).gte('created_at', since).order('created_at', { ascending: false }).limit(max);
    throw new HttpError(429, 'rate_limited', `${message} Try again in about ${formatWait(retryAfterSeconds((data ?? []).map(row => String(row.created_at)), windowSeconds))}.`);
  }
  await db().from('rate_events').insert({ bucket });
}

export async function handleBackendRequest(req: Request, options: { clientIp?: string } = {}): Promise<Response> {
  const env = getServerEnv();
  const url = new URL(req.url);
  const path = (url.pathname.replace(/^\/api\/v1/, '') || '/').replace(/\/+$/, '') || '/';
  const matched = routes.find(item => item.method === req.method && item.regex.test(path));
  if (!matched) {
    const known = routes.some(item => item.regex.test(path));
    return json({ error: { code: known ? 'method_not_allowed' : 'not_found', message: known ? 'Method not allowed.' : 'Not found.' } }, known ? 405 : 404);
  }
  const match = matched.regex.exec(path)!;
  const params: Record<string, string> = {};
  matched.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1]); });

  const cookies = parseCookies(req.headers.get('cookie'));
  const secure = env.siteUrl.startsWith('https://') ? '; Secure' : '';
  const setCookies: string[] = [];
  const ctx: Ctx = {
    req, url, params, cookies,
    // Only ever the address the proxy route verified and passed in-process; request headers (which a client controls) are not consulted.
    ip: options.clientIp ?? UNVERIFIED_IP,
    setCookie: (name, value, maxAge = 0) => setCookies.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`),
    body: async schema => {
      let raw: unknown;
      try { raw = await req.json(); } catch { throw new HttpError(400, 'invalid_json', 'The request body must be valid JSON.'); }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new HttpError(422, 'validation_failed', 'Some details need your attention.', z.flattenError(parsed.error as z.ZodError).fieldErrors as Record<string, string[]>);
      return parsed.data;
    },
  };

  const finish = (response: Response) => { for (const cookie of setCookies) response.headers.append('Set-Cookie', cookie); return response; };
  try {
    if (matched.csrf) {
      const header = req.headers.get('x-csrf-token');
      if (!header || !cookies[COOKIES.csrf] || !safeEqual(header, cookies[COOKIES.csrf])) throw new HttpError(403, 'csrf_invalid', 'Your session expired. Please try again.');
    }
    const result = await matched.handler(ctx);
    return finish(result instanceof Response ? result : result == null ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : json(result));
  } catch (error) {
    if (error instanceof HttpError) {
      return finish(json({ error: { code: error.code, message: error.message, ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) } }, error.status));
    }
    console.error('[backend] unhandled error', error);
    return finish(json({ error: { code: 'server_error', message: 'Something went wrong.' } }, 500));
  }
}

// ───────────── storage paths ─────────────

export const MEDIA_BUCKET = 'media';
const publicPrefix = () => `${getServerEnv().supabase!.url}/storage/v1/object/public/${MEDIA_BUCKET}/`;
/** Stored value → URL the browser can load. Local `/images/…` assets and absolute URLs pass through. */
/** '' (no image) stays '' — it must never become the bare bucket prefix. */
export const imageUrl = (stored: string) => (stored === '' || stored.startsWith('/') || /^https?:\/\//.test(stored) ? stored : `${publicPrefix()}${stored}`);
/** URL → stable storage path when it points at our bucket; anything else is kept as given. */
export const storedImage = (url: string) => (url.startsWith(publicPrefix()) ? url.slice(publicPrefix().length) : url);
export const isStoragePath = (stored: string) => !stored.startsWith('/') && !/^https?:\/\//.test(stored);

/** Hero banner videos live in their own bucket (migration 0010) so the image bucket's image-only, 5 MB rules stay untouched. */
export const BANNER_BUCKET = 'banner-media';
const bannerPrefix = () => `${getServerEnv().supabase!.url}/storage/v1/object/public/${BANNER_BUCKET}/`;
export const bannerVideoUrl = (stored: string) => (stored === '' || stored.startsWith('/') || /^https?:\/\//.test(stored) ? stored : `${bannerPrefix()}${stored}`);
export const storedBannerVideo = (url: string) => (url.startsWith(bannerPrefix()) ? url.slice(bannerPrefix().length) : url);
export async function removeBannerVideos(paths: string[]) {
  const targets = [...new Set(paths.filter(path => path !== '' && isStoragePath(path)))];
  if (!targets.length) return;
  const { error } = await db().storage.from(BANNER_BUCKET).remove(targets);
  if (error) console.error('[backend] banner video cleanup failed', error.message);
}
export async function removeStorageObjects(paths: string[]) {
  const targets = [...new Set(paths.filter(path => path !== '' && isStoragePath(path)))];
  if (!targets.length) return;
  const { error } = await db().storage.from(MEDIA_BUCKET).remove(targets);
  if (error) console.error('[backend] storage cleanup failed', error.message);
}
