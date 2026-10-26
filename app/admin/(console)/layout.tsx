import { redirect } from 'next/navigation';
import { AdminShell } from '@/components/admin/admin-shell';
import { isApiError } from '@/lib/api/errors';
import type { AdminUser } from '@/lib/api/schemas';
import { serverApi } from '@/lib/api/server';

// Always rendered per request: it depends on the visitor's session cookie.
export const dynamic = 'force-dynamic';

/**
 * Server-side admin guard. The backend validates the HttpOnly session cookie on every request;
 * the browser holds no "logged in" flag that could be forged. Anything but a valid admin → /admin/login.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  let admin: AdminUser | null = null;
  try {
    admin = (await serverApi.admin.auth.me({ forwardCookies: true })).admin;
  } catch (error) {
    if (!(isApiError(error) && (error.status === 401 || error.status === 403))) throw error;
  }
  if (!admin) redirect('/admin/login');
  return <AdminShell admin={admin}>{children}</AdminShell>;
}
