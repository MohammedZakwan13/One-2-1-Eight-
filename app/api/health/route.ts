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

  if (new URL(request.url).searchParams.get('deep') === '1' && !env.mockEnabled) {
    try {
      const response = await fetch(`${env.apiBaseUrl}/health`, { cache: 'no-store', signal: AbortSignal.timeout(Math.min(env.apiTimeoutMs, 3000)), redirect: 'manual' });
      if (!response.ok) return Response.json({ status: 'degraded', backend: 'unhealthy' }, { status: 503, headers });
    } catch {
      return Response.json({ status: 'degraded', backend: 'unreachable' }, { status: 503, headers });
    }
  }
  return Response.json({ status: 'ok', mode: env.mockEnabled ? 'mock' : 'live' }, { headers });
}
