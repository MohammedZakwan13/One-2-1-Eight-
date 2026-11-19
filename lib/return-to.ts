/**
 * Post-login destination. Only a same-site absolute path is accepted: anything that could leave the site or loop back into sign-in becomes null
 * (external URLs, protocol-relative "//host", backslashes, control characters, "/login", "/admin", "/api", over-long values).
 * The result is rebuilt from the parsed path and query, never the raw input.
 */
const BASE = 'http://internal.invalid';

export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, BASE); } catch { return null; }
  if (url.origin !== BASE) return null;
  const path = url.pathname;
  if (/^\/(login|admin|api)(\/|$)/.test(path)) return null;
  return `${path}${url.search}`;
}

/** `/login?returnTo=<encoded path>`; an unsafe path just gives the plain login URL. */
export function loginUrl(returnTo?: string | null): string {
  const safe = safeReturnTo(returnTo);
  return safe ? `/login?returnTo=${encodeURIComponent(safe)}` : '/login';
}
