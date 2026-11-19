import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  secret: 'whsec_' + Buffer.from('test-webhook-signing-key').toString('base64'),
  env: {} as Record<string, unknown>,
  events: new Set<string>(),
  updates: [] as { patch: Record<string, unknown>; column: string; value: unknown }[],
}));

vi.mock('@/lib/env', () => ({ getServerEnv: () => h.env }));
vi.mock('@/lib/backend/otp', () => ({ logOtp: () => undefined }));
vi.mock('@/lib/backend/core', () => ({
  safeEqual: (a: string, b: string) => a === b,
  HttpError: class extends Error {},
  trackingUrl: () => 'https://one21eight.test/x',
  db: () => ({
    from: (table: string) => {
      if (table === 'webhook_events') {
        return { insert: async (row: { event_id: string }) => {
          if (h.events.has(row.event_id)) return { error: { code: '23505' } };
          h.events.add(row.event_id); return { error: null };
        } };
      }
      return { update: (patch: Record<string, unknown>) => ({ eq: async (column: string, value: unknown) => { h.updates.push({ patch, column, value }); return { error: null }; } }) };
    },
  }),
}));

import { POST } from '@/app/api/webhooks/resend/route';

const now = () => String(Math.floor(Date.now() / 1000));
function signed(body: string, { id = 'msg_1', timestamp = now(), secret = h.secret } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  return new Request('https://one21eight.test/api/webhooks/resend', { method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature } });
}
const event = (type: string, emailId = 're-1') => JSON.stringify({ type, data: { email_id: emailId } });

beforeEach(() => {
  h.env = { apiMode: 'supabase', resend: { apiKey: 'k', from: 'f', internalEmail: null, webhookSecret: h.secret } };
  h.events.clear(); h.updates.length = 0;
});

describe('Resend delivery webhook', () => {
  it('is disabled (503) until RESEND_WEBHOOK_SECRET is configured', async () => {
    h.env = { apiMode: 'supabase', resend: { apiKey: 'k', from: 'f', internalEmail: null, webhookSecret: null } };
    expect((await POST(signed(event('email.delivered')))).status).toBe(503);
    h.env = { apiMode: 'supabase', resend: null };
    expect((await POST(signed(event('email.delivered')))).status).toBe(503);
    expect(h.updates).toHaveLength(0);
  });

  it('rejects a missing, forged or tampered signature (401) without touching the log', async () => {
    const body = event('email.delivered');
    const forged = new Request('https://one21eight.test/api/webhooks/resend', { method: 'POST', body, headers: { 'svix-id': 'msg_x', 'svix-timestamp': now(), 'svix-signature': 'v1,AAAA' } });
    expect((await POST(forged)).status).toBe(401);
    const missing = new Request('https://one21eight.test/api/webhooks/resend', { method: 'POST', body });
    expect((await POST(missing)).status).toBe(401);
    const wrongKey = signed(body, { secret: 'whsec_' + Buffer.from('another-key').toString('base64') });
    expect((await POST(wrongKey)).status).toBe(401);
    expect(h.updates).toHaveLength(0);
  });

  it('rejects an old (replayed) timestamp', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await POST(signed(event('email.delivered'), { timestamp: old }))).status).toBe(401);
    expect(h.updates).toHaveLength(0);
  });

  it.each([
    ['email.delivered', 'delivered'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
    ['email.failed', 'failed'],
  ])('a valid %s event sets the matching email_log row to %s, found by the stored message id', async (type, status) => {
    const response = await POST(signed(event(type, 're-42'), { id: `msg_${type}` }));
    expect(response.status).toBe(200);
    expect(h.updates).toEqual([expect.objectContaining({ column: 'provider_message_id', value: 're-42', patch: expect.objectContaining({ status }) })]);
  });

  it('processes each event id once: a repeated delivery of the same event changes nothing', async () => {
    expect((await POST(signed(event('email.delivered'), { id: 'msg_dupe' }))).status).toBe(200);
    const again = await POST(signed(event('email.bounced'), { id: 'msg_dupe' }));
    expect(await again.json()).toEqual({ status: 'duplicate' });
    expect(h.updates).toHaveLength(1);
  });

  it('acknowledges event types it does not track without changing anything', async () => {
    expect((await POST(signed(event('email.sent'), { id: 'msg_other' }))).status).toBe(200);
    expect(h.updates).toHaveLength(0);
  });
});
