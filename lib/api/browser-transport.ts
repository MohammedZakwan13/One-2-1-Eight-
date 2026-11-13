import type { Transport } from '@/lib/api/http';
import { csrfTokenSchema } from '@/lib/api/schemas';

/**
 * Browser transport: always talks to the same-origin proxy (`/api/v1/*`), so
 * session cookies stay first-party and the real backend URL is never exposed.
 */

const API_PREFIX = '/api/v1';
let csrfPromise: Promise<string> | null = null;

/**
 * One shared, in-flight CSRF token for the whole page: JSON calls and uploads must all use it. Fetching a token per request would let two
 * simultaneous first requests mint different tokens (the last cookie wins) and make one of them fail.
 */
export async function loadCsrfToken(force = false): Promise<string> {
  if (!csrfPromise || force) {
    csrfPromise = fetch(`${API_PREFIX}/csrf-token`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) throw new Error(`csrf-token ${response.status}`);
        return csrfTokenSchema.parse(await response.json()).token;
      })
      .catch(error => {
        csrfPromise = null;
        throw error;
      });
  }
  return csrfPromise;
}

export const browserTransport: Transport = async request => {
  const mutating = request.method !== 'GET';
  const send = async (forceToken: boolean) => {
    const headers = { ...request.headers };
    if (mutating) headers['X-CSRF-Token'] = await loadCsrfToken(forceToken);
    return fetch(`${API_PREFIX}${request.path}`, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  };
  const response = await send(false);
  if (mutating && response.status === 403) {
    // The CSRF cookie/token pair may have rotated – refresh once and retry.
    const clone = response.clone();
    const body = await clone.json().catch(() => null) as { error?: { code?: string } } | null;
    if (body?.error?.code === 'csrf_invalid') return send(true);
  }
  return response;
};
