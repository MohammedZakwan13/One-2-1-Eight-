import { isSameOriginWrite } from '@/lib/api/proxy';
import { getServerEnv } from '@/lib/env';

/**
 * Multipart banner-video upload/delete. Like /api/v1/admin/uploads this bypasses the generic JSON proxy (which buffers bodies as text and
 * caps them at 1 MB); authentication, CSRF, size and format validation all run inside the backend dispatcher.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
  const env = getServerEnv();
  if (env.apiMode !== 'supabase') return fail(404, 'not_found', 'Not found.');
  if (!isSameOriginWrite(request.headers.get('origin'), request.headers.get('x-forwarded-host') ?? request.headers.get('host'))) {
    return fail(403, 'cross_origin', 'Cross-origin requests are not allowed.');
  }
  const { handleBackendRequest } = await import('@/lib/backend');
  return handleBackendRequest(request);
}

export { handle as POST, handle as DELETE };
