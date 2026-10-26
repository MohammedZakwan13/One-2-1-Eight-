/**
 * Pure helpers for the same-origin API proxy (`app/api/v1/[...path]/route.ts`).
 * Kept separate from the route so the security-relevant rules are unit-tested.
 */

const SEGMENT = /^[A-Za-z0-9._~%@:+,=-]+$/;

/** Returns the safe upstream path (`/a/b`) or null if any segment could escape the API root. */
export function sanitizeProxyPath(segments: string[]): string | null {
  if (!segments.length || segments.length > 8) return null;
  const clean: string[] = [];
  for (const raw of segments) {
    if (!raw || !SEGMENT.test(raw)) return null;
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { return null; }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
    clean.push(encodeURIComponent(decoded).replace(/%40/g, '@'));
  }
  return `/${clean.join('/')}`;
}

/** Cross-site writes are rejected: a browser-supplied Origin must match the host being served. */
export function isSameOriginWrite(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // non-browser client (no ambient cookies to abuse)
  if (!host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

export const FORWARDED_REQUEST_HEADERS = ['cookie', 'content-type', 'accept', 'accept-language', 'idempotency-key', 'x-csrf-token', 'user-agent'] as const;
export const MAX_PROXY_BODY_BYTES = 1_000_000;
