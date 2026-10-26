/**
 * Pure helpers for the /admin edge gate (see middleware.ts).
 *
 * The middleware only checks that a session cookie is *present* – a cheap first filter that
 * keeps anonymous users away from admin routes. The real authorisation check happens on the
 * server in `app/admin/(console)/layout.tsx`, which asks the backend to validate the session.
 */

export const ADMIN_LOGIN_PATH = '/admin/login';

export function adminGateDecision(pathname: string, hasSessionCookie: boolean): 'allow' | 'redirect-to-login' {
  if (!pathname.startsWith('/admin')) return 'allow';
  if (pathname === ADMIN_LOGIN_PATH) return 'allow';
  return hasSessionCookie ? 'allow' : 'redirect-to-login';
}

/** Prevents open redirects: only same-site /admin paths are accepted as a post-login target. */
export function safeAdminNext(next: string | null | undefined): string {
  if (!next) return '/admin';
  if (!next.startsWith('/admin') || next.startsWith('//') || next.includes('\\') || /[\r\n]/.test(next)) return '/admin';
  if (next.startsWith(ADMIN_LOGIN_PATH)) return '/admin';
  return next;
}
