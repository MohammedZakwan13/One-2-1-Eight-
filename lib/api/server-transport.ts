import 'server-only';
import { getServerEnv } from '@/lib/env';
import type { Transport } from '@/lib/api/http';

/**
 * Server transport used by React Server Components, route handlers and metadata.
 * - live mode: calls an external backend directly at API_BASE_URL (server-side only, never exposed to browsers)
 * - supabase mode: dispatches in-process to the built-in Supabase backend (lib/backend)
 */
type Cached = { at: number; status: number; type: string; body: string };
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached | null>>();
const MAX_STALE_MS = 10 * 60_000;

/** Drops cached public GET responses; called after any write so admin edits show up immediately. */
export function clearServerCache() { cache.clear(); }

const replay = (entry: Cached) => new Response(entry.body, { status: entry.status, headers: { 'content-type': entry.type } });

/**
 * Supabase mode dispatches in-process, which bypasses Next's fetch cache, so every navigation re-queried the database.
 * Cache only anonymous GETs that opted in with `revalidate`: fresh within the TTL, stale-while-revalidate afterwards.
 */
async function cachedBackend(request: Parameters<Transport>[0], run: () => Promise<Response>): Promise<Response> {
  const ttl = request.method === 'GET' && !request.forwardCookies && typeof request.revalidate === 'number' ? request.revalidate * 1000 : 0;
  if (!ttl) {
    const response = await run();
    if (request.method !== 'GET' && response.status < 400) clearServerCache();
    return response;
  }
  const key = request.path;
  const refresh = () => {
    let job = inflight.get(key);
    if (!job) {
      job = run().then(async response => {
        if (response.status !== 200) return null;
        const entry = { at: Date.now(), status: 200, type: response.headers.get('content-type') ?? 'application/json', body: await response.text() };
        cache.set(key, entry);
        return entry;
      }).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    return job;
  };
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return replay(hit);
  if (hit && Date.now() - hit.at < MAX_STALE_MS) { void refresh().catch(() => undefined); return replay(hit); }
  const fresh = await refresh();
  return fresh ? replay(fresh) : run();
}

export const serverTransport: Transport = async request => {
  const env = getServerEnv();
  const headers = new Headers(request.headers);
  const timeout = AbortSignal.timeout(env.apiTimeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  if (request.forwardCookies) {
    const { cookies } = await import('next/headers');
    const cookieHeader = (await cookies()).toString();
    if (cookieHeader) headers.set('cookie', cookieHeader);
  }

  if (env.apiMode === 'supabase') {
    const { handleBackendRequest } = await import('@/lib/backend');
    return cachedBackend(request, () => handleBackendRequest(new Request(`http://backend.local/api/v1${request.path}`, { method: request.method, headers, body: request.body, signal }), { clientIp: request.clientIp }));
  }

  const init: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } } = {
    method: request.method,
    headers,
    body: request.body,
    signal,
    // The API must never redirect; refusing to follow keeps the proxy from being steered elsewhere.
    redirect: 'manual',
  };
  if (request.method === 'GET') {
    if (request.revalidate === false || request.revalidate === undefined || request.forwardCookies) init.cache = 'no-store';
    else init.next = { revalidate: request.revalidate, tags: request.tags };
  } else {
    init.cache = 'no-store';
  }
  return fetch(`${env.apiBaseUrl}${request.path}`, init);
};
