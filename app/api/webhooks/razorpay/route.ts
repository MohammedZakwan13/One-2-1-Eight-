import { getServerEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reply = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Razorpay → us. The signature is verified over the RAW body; the payment is then settled by the
 * database function (idempotent), so repeated or replayed events cannot double-apply.
 * Dashboard → Settings → Webhooks → URL: {SITE}/api/webhooks/razorpay, events: payment.captured, order.paid.
 */
export async function POST(request: Request) {
  const env = getServerEnv();
  if (env.apiMode !== 'supabase' || !env.razorpay?.webhookSecret) return reply(503, { error: 'webhook_not_configured' });
  const { verifyRazorpayWebhook, sendOrderEmail } = await import('@/lib/backend/integrations');
  const { db } = await import('@/lib/backend/core');
  const { loadOrder, orderMailData, toOrder } = await import('@/lib/backend/data');

  const raw = await request.text();
  if (!verifyRazorpayWebhook(raw, request.headers.get('x-razorpay-signature') ?? '')) return reply(401, { error: 'invalid_signature' });

  const eventId = request.headers.get('x-razorpay-event-id');
  if (eventId) {
    const { error } = await db().from('webhook_events').insert({ provider: 'razorpay', event_id: eventId });
    if (error?.code === '23505') return reply(200, { status: 'duplicate' });
  }

  let event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
  try { event = JSON.parse(raw); } catch { return reply(400, { error: 'invalid_json' }); }
  if (event.event !== 'payment.captured' && event.event !== 'order.paid') return reply(200, { status: 'ignored' });

  const entity = event.payload?.payment?.entity;
  if (!entity?.id || !entity.order_id) return reply(200, { status: 'ignored' });
  const { data: payment } = await db().from('payments').select('order_id').eq('provider_order_id', entity.order_id).maybeSingle();
  if (!payment) return reply(200, { status: 'unknown_order' });

  const { data: settled, error } = await db().rpc('settle_payment', { p_order: payment.order_id, p_provider_payment: entity.id, p_success: true });
  if (error) {
    console.error('[webhook:razorpay] settle failed', error.message);
    if (eventId) await db().from('webhook_events').delete().eq('provider', 'razorpay').eq('event_id', eventId);
    return reply(500, { error: 'settle_failed' });
  }
  if ((settled as { changed?: boolean }).changed) {
    const row = await loadOrder(payment.order_id);
    if (row) await sendOrderEmail(orderMailData(toOrder(row)), 'confirmation');
  }
  return reply(200, { status: 'ok' });
}
