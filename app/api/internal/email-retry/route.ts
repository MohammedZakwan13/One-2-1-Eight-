import { createHash, timingSafeEqual } from 'node:crypto';
import { getServerEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const digest = (value: string) => createHash('sha256').update(value).digest();
const reply = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Email retry + crash-recovery run. Called by the VPS cron job every 5 minutes (see docs/EMAIL_SETUP.md):
 *
 *   POST /api/internal/email-retry
 *   x-email-retry-secret: <EMAIL_RETRY_SECRET>
 *
 * Constant-time secret comparison; disabled (503) until EMAIL_RETRY_SECRET is configured. The response only carries counts, never
 * addresses, subjects, errors or credentials. Overlapping runs are safe: every row is claimed atomically before it is sent.
 */
export async function POST(request: Request) {
  const env = getServerEnv();
  if (env.apiMode !== 'supabase') return reply(503, { error: 'not_available' });
  if (!env.emailRetrySecret) return reply(503, { error: 'email_retry_not_configured' });
  const provided = request.headers.get('x-email-retry-secret') ?? '';
  if (!timingSafeEqual(digest(provided), digest(env.emailRetrySecret))) return reply(401, { error: 'unauthorized' });

  try {
    const { runSupabaseEmailRetry } = await import('@/lib/backend/email/retry-supabase');
    const result = await runSupabaseEmailRetry();
    if (result.migrationRequired) return reply(503, { error: 'migration_required', detail: 'Apply supabase/migrations/0009_email_log_attempts.sql first.' });
    return reply(200, result);
  } catch (error) {
    console.error('[email-retry] run failed', error instanceof Error ? error.message : 'error');
    return reply(500, { error: 'run_failed' });
  }
}
