import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { getServerEnv } from '@/lib/env';
import { UNVERIFIED_IP, resolveClientIp } from '@/lib/backend/client-ip';
import { FORWARDED_REQUEST_HEADERS, MAX_PROXY_BODY_BYTES, isSameOriginWrite, sanitizeProxyPath } from '@/lib/api/proxy';
import { serverTransport } from '@/lib/api/server-transport';
import type { HttpMethod } from '@/lib/api/http';

/**
 * Same-origin proxy to the backend REST API (built-in Supabase backend or an external API).
 *
 * Why a proxy: session cookies stay first-party (no CORS, no third-party cookie issues), the real
 * API URL is never exposed to browsers, and every call passes one audited choke point.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let warnedUnverified = false;

const error = (status: number, code: string, message: string, requestId: string) =>
  Response.json({ error: { code, message, requestId } }, { status, headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId } });

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const method = request.method as HttpMethod;
  let env: ReturnType<typeof getServerEnv>;
  try {
    env = getServerEnv();
  } catch (cause) {
    console.error('[proxy] invalid server configuration', cause);
    return error(500, 'misconfigured', 'The store is not configured correctly.', requestId);
  }

  const { path } = await context.params;
  const upstreamPath = sanitizeProxyPath(path);
  if (!upstreamPath) return error(400, 'invalid_path', 'Invalid request path.', requestId);

  if (method !== 'GET' && !isSameOriginWrite(request.headers.get('origin'), request.headers.get('x-forwarded-host') ?? request.headers.get('host'))) {
    return error(403, 'cross_origin', 'Cross-origin requests are not allowed.', requestId);
  }

  let body: string | undefined;
  if (method !== 'GET') {
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_PROXY_BODY_BYTES) return error(413, 'payload_too_large', 'The request is too large.', requestId);
    const text = await request.text();
    if (text.length > MAX_PROXY_BODY_BYTES) return error(413, 'payload_too_large', 'The request is too large.', requestId);
    body = text || undefined;
  }

  const headers: Record<string, string> = { 'x-request-id': requestId };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  // Client IP for rate limiting: only what a trusted proxy provably vouches for (never the client's own X-Forwarded-For). Unverified requests share one bucket.
  const clientIp = resolveClientIp(request.headers, env.trustedProxy);
  if (clientIp === UNVERIFIED_IP) {
    if (!warnedUnverified) { warnedUnverified = true; console.warn('[net] client IP not verified (TRUSTED_PROXY); IP-based rate limits use one shared bucket'); }
  } else headers['x-forwarded-for'] = clientIp;

  let upstream: Response;
  try {
    upstream = await serverTransport({ method, path: `${upstreamPath}${request.nextUrl.search}`, headers, body, signal: request.signal, clientIp });
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    console.error(`[proxy] ${method} ${upstreamPath} failed`, cause instanceof Error ? cause.message : cause);
    return timedOut
      ? error(504, 'timeout', 'The store took too long to respond. Please try again.', requestId)
      : error(502, 'upstream_unavailable', 'The store is temporarily unavailable. Please try again shortly.', requestId);
  }

  if (upstream.status >= 300 && upstream.status < 400) return error(502, 'upstream_redirect', 'Unexpected response from the store.', requestId);

  if (upstream.status < 400 && method !== 'GET') {
    try {
      const { revalidateTag } = await import('next/cache');
      if (upstreamPath.startsWith('/admin/content') || upstreamPath.startsWith('/admin/categories')) {
        revalidateTag('content');
      } else if (upstreamPath.startsWith('/admin/products')) {
        revalidateTag('products');
      }
    } catch {
      // Revalidation may be unavailable outside a Next.js server context.
    }
  }

  const responseHeaders = new Headers({ 'Cache-Control': 'no-store', 'x-request-id': requestId });
  for (const name of ['content-type', 'content-disposition', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('Set-Cookie', cookie);
  return new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
