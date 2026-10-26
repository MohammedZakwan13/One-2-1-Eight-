import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_LOGIN_PATH, adminGateDecision } from '@/lib/admin-gate';

/**
 * Edge gate for the isolated /admin area. Real authorisation is enforced server-side by the
 * backend (see `app/admin/(console)/layout.tsx`); this only keeps anonymous visitors out cheaply
 * and makes sure admin pages are never indexed or cached.
 */
export function middleware(request: NextRequest) {
  const cookieName = process.env.ADMIN_SESSION_COOKIE || 'o218_admin_session';
  const { pathname } = request.nextUrl;
  const decision = adminGateDecision(pathname, Boolean(request.cookies.get(cookieName)?.value));

  if (decision === 'redirect-to-login') {
    const url = request.nextUrl.clone();
    url.pathname = ADMIN_LOGIN_PATH;
    url.search = '';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = { matcher: ['/admin/:path*'] };
