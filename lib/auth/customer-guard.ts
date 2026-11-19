import 'server-only';
import { redirect } from 'next/navigation';
import { isApiError } from '@/lib/api/errors';
import { serverApi } from '@/lib/api/server';
import { loginUrl } from '@/lib/return-to';

/**
 * Server-side guard for customer-only pages (checkout). The backend validates the HttpOnly session cookie on every call; the browser holds no flag that could be
 * forged. A guest is sent to sign-in with a validated return path. Any failure other than "not signed in" is rethrown, never treated as a guest or as signed in.
 * (Pages using this must be dynamic: they depend on the visitor's cookie.)
 */
export async function requireCustomerPage(returnTo: string): Promise<void> {
  let signedIn = false;
  try {
    await serverApi.auth.me(undefined, { forwardCookies: true });
    signedIn = true;
  } catch (error) {
    if (!(isApiError(error) && error.status === 401)) throw error;
  }
  if (!signedIn) redirect(loginUrl(returnTo));
}
