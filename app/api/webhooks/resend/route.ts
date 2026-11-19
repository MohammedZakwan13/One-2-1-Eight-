import { getServerEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reply = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const STATUS_FOR_EVENT: Record<string, string> = {
  'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed',
};

/**
 * Resend → us (delivery tracking only; this does not create leads from inbound email).
 * Dashboard → Webhooks → URL: {SITE}/api/webhooks/resend, events: email.delivered, email.bounced, email.complained, email.failed.
 * Signed with Svix; stale timestamps are rejected and each event id is processed once.
 */
export async function POST(request: Request) {
  const env = getServerEnv();
  if (env.apiMode !== 'supabase' || !env.resend?.webhookSecret) return reply(503, { error: 'webhook_not_configured' });
  const { verifyResendWebhook } = await import('@/lib/backend/integrations');
  const { db } = await import('@/lib/backend/core');

  const raw = await request.text();
  const id = request.headers.get('svix-id');
  if (!verifyResendWebhook(env.resend.webhookSecret, { id, timestamp: request.headers.get('svix-timestamp'), signature: request.headers.get('svix-signature') }, raw)) {
    return reply(401, { error: 'invalid_signature' });
  }
  const { error: dupe } = await db().from('webhook_events').insert({ provider: 'resend', event_id: id! });
  if (dupe?.code === '23505') return reply(200, { status: 'duplicate' });

  let event: { type?: string; data?: { email_id?: string } };
  try { event = JSON.parse(raw); } catch { return reply(400, { error: 'invalid_json' }); }
  const status = STATUS_FOR_EVENT[event.type ?? ''];
  if (status && event.data?.email_id) {
    await db().from('email_log').update({ status, updated_at: new Date().toISOString() }).eq('provider_message_id', event.data.email_id);
  }
  return reply(200, { status: 'ok' });
}
