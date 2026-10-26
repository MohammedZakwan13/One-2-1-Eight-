/**
 * Security response headers. Pure so it can be unit-tested and imported from next.config.ts
 * (keep this file free of path aliases and runtime-only imports).
 *
 * CSP note: Next.js emits inline bootstrap scripts, so `script-src` needs 'unsafe-inline'
 * unless nonces are used (which forces fully dynamic rendering). Every other directive is strict.
 * Payment SDKs / analytics must be added explicitly through the CSP_EXTRA_* variables.
 */

export type HeaderEntry = { key: string; value: string };

const list = (value: string | undefined) => (value ?? '').split(/\s+/).map(item => item.trim()).filter(Boolean);

export function buildCsp(env: Record<string, string | undefined>, isDev: boolean): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : []), ...list(env.CSP_EXTRA_SCRIPT_SRC)];
  const connectSrc = ["'self'", ...(isDev ? ['ws:', 'wss:'] : []), ...list(env.CSP_EXTRA_CONNECT_SRC)];
  const imgSrc = ["'self'", 'data:', 'blob:', 'https:', ...list(env.CSP_EXTRA_IMG_SRC)];
  const frameSrc = list(env.CSP_EXTRA_FRAME_SRC);
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc.join(' ')}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    frameSrc.length ? `frame-src ${frameSrc.join(' ')}` : "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ];
  return directives.join('; ');
}

export function securityHeaders(env: Record<string, string | undefined>, isDev: boolean): HeaderEntry[] {
  const headers: HeaderEntry[] = [
    { key: 'Content-Security-Policy', value: buildCsp(env, isDev) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self), interest-cohort=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    { key: 'X-DNS-Prefetch-Control', value: 'on' },
  ];
  if (!isDev) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' });
  return headers;
}
