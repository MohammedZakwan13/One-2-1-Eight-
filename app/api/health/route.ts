import { getServerEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health        → liveness (is this Next.js process up and correctly configured?)
 * GET /api/health?deep=1 → readiness (also checks the backend's own GET /health)
 */
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  let env;
  try {
    env = getServerEnv();
  } catch {
    return Response.json({ status: 'misconfigured' }, { status: 503, headers });
  }

  if (new URL(request.url).searchParams.get('deep') === '1') {
    try {
      if (env.apiMode === 'supabase') {
        const { handleBackendRequest } = await import('@/lib/backend');
        const response = await handleBackendRequest(new Request(`http://backend.local/api/v1/ready`));
        if (!response.ok) return Response.json({ status: 'degraded', backend: 'database_unreachable' }, { status: 503, headers });
      } else {
        const response = await fetch(`${env.apiBaseUrl}/health`, { cache: 'no-store', signal: AbortSignal.timeout(Math.min(env.apiTimeoutMs, 3000)), redirect: 'manual' });
        if (!response.ok) return Response.json({ status: 'degraded', backend: 'unhealthy' }, { status: 503, headers });
      }
    } catch {
      return Response.json({ status: 'degraded', backend: 'unreachable' }, { status: 503, headers });
    }
  }
  return Response.json({ status: 'ok', mode: env.apiMode }, { headers });
}
