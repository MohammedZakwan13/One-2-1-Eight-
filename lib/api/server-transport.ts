import 'server-only';
import { getServerEnv } from '@/lib/env';
import type { Transport } from '@/lib/api/http';

/**
 * Server transport used by React Server Components, route handlers and metadata.
 * - live mode: calls the backend directly at API_BASE_URL (server-side only, never exposed to browsers)
 * - mock mode: dispatches in-process to the development/test mock (blocked outside development/test by `getServerEnv`)
 */
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

  if (env.mockEnabled) {
    const { handleMockRequest } = await import('@/mocks/router');
    const mockRequest = new Request(`http://mock.local/api/v1${request.path}`, { method: request.method, headers, body: request.body, signal });
    return handleMockRequest(mockRequest);
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
