import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeEmailDb } from './helpers/fake-email-db';

const state = vi.hoisted(() => ({
  clock: { t: Date.parse('2026-11-10T10:00:00Z'), now() { return this.t; } },
  fake: null as unknown,
  env: {} as Record<string, unknown>,
}));

vi.mock('@/lib/backend/core', () => ({
  db: () => state.fake,
  safeEqual: () => true,
  HttpError: class extends Error {},
  trackingUrl: (id: string) => `https://one21eight.test/order-confirmation?order=${id}`,
}));
vi.mock('@/lib/backend/otp', () => ({ logOtp: () => undefined }));
vi.mock('@/lib/env', () => ({ getServerEnv: () => state.env }));

import { attemptDelivery, parseRetryAfter, resetEmailQueueProbe, sendEmail, type EmailInput } from '@/lib/backend/integrations';

const API_KEY = 're_test_key_SECRET';
const resendEnv = () => ({
  mailpit: null,
  emailProvider: 'resend',
  resend: { apiKey: API_KEY, from: 'ONE 2 1 EIGHT <orders@send.one21eight.com>', internalEmail: 'one21eight@gmail.com', webhookSecret: null },
  emailReplyTo: 'one21eight@gmail.com',
  internalNotificationEmail: 'one21eight@gmail.com',
});
const MAIL: EmailInput = { kind: 'order_status', to: 'customer@example.com', subject: 'Order 1: shipped', html: '<p>x</p>', text: 'x', dedupeKey: 'order:o1:shipped', entityType: 'order', entityId: 'o1' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
type Fake = ReturnType<typeof createFakeEmailDb>;
const fake = () => state.fake as Fake;
const advance = (minutes: number) => { state.clock.t += minutes * 60_000; };
const sync = () => vi.setSystemTime(state.clock.t);

type Handler = () => Response | Promise<Response>;
/** Scripts Resend's endpoint. Any other URL is a test failure: nothing may call another provider. */
function resend(handler: Handler = () => json(200, { id: 're-1' })) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).includes('api.resend.com')) return handler();
    throw new Error(`unexpected fetch ${String(input)}`);
  });
}
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
const customerCalls = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((call: unknown[]) => (bodyOf(call).to as string[]).includes('customer@example.com'));
const alertCalls = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((call: unknown[]) => (bodyOf(call).to as string[]).includes('one21eight@gmail.com'));

beforeEach(() => {
  state.clock.t = Date.parse('2026-11-10T10:00:00Z');
  state.fake = createFakeEmailDb(state.clock);
  state.env = resendEnv();
  resetEmailQueueProbe();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(state.clock.t);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Resend delivery', () => {
  it('sends once with the planned sender, Reply-To and an Idempotency-Key, records the raw message id, and never logs the API key', async () => {
    const out = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = resend();
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'accepted', providerMessageId: 're-1' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${API_KEY}`, 'Idempotency-Key': 'order:o1:shipped' });
    expect(bodyOf(spy.mock.calls[0])).toMatchObject({ from: 'ONE 2 1 EIGHT <orders@send.one21eight.com>', to: ['customer@example.com'], reply_to: 'one21eight@gmail.com', subject: 'Order 1: shipped' });
    // the message id is stored unprefixed: the Resend webhook finds the row by it
    expect(fake().rows[0]).toMatchObject({ status: 'accepted', attempts: 1, provider: 'resend', provider_message_id: 're-1', next_attempt_at: null, error: null });
    expect(JSON.stringify([out.mock.calls, err.mock.calls])).not.toContain(API_KEY);
  });

  it('prevents duplicates: the same notification is never sent twice (sequential or simultaneous)', async () => {
    const spy = resend(async () => { await Promise.resolve(); return json(200, { id: 're-1' }); });
    const results = await Promise.all([sendEmail(MAIL), sendEmail(MAIL), sendEmail(MAIL)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results.filter(r => r.status === 'accepted')).toHaveLength(1);
    expect(await sendEmail(MAIL)).toEqual({ status: 'already_sent' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fake().rows).toHaveLength(1);
  });

  it('a temporary failure (5xx) is retried only after the backoff, with the SAME idempotency key, then succeeds once', async () => {
    let calls = 0;
    const spy = resend(() => (++calls === 1 ? json(503, { message: 'unavailable' }) : json(200, { id: 're-2' })));
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'failed', failureKind: 'transient' });
    const row = fake().rows[0];
    expect(row).toMatchObject({ status: 'failed', attempts: 1, error: 'transient:http_503' });
    expect(Date.parse(String(row.next_attempt_at)) - state.clock.t).toBe(5 * 60_000);

    advance(2); sync();
    expect(await attemptDelivery(row.id, MAIL)).toEqual({ status: 'in_progress' }); // not due yet: no claim, no send
    expect(spy).toHaveBeenCalledTimes(1);

    advance(4); sync(); // 6 minutes after the failure
    expect(await attemptDelivery(row.id, MAIL)).toMatchObject({ status: 'accepted' });
    expect(spy).toHaveBeenCalledTimes(2);
    const keys = spy.mock.calls.map(call => ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual(['order:o1:shipped', 'order:o1:shipped']);
    expect(fake().rows[0]).toMatchObject({ status: 'accepted', attempts: 2, provider_message_id: 're-2' });
    expect(await attemptDelivery(row.id, MAIL)).toEqual({ status: 'in_progress' }); // accepted rows are never claimed again
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a timeout or network error is retried (safe: Resend deduplicates on the idempotency key), never marked uncertain', async () => {
    let calls = 0;
    const spy = resend(() => { if (++calls === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); return json(200, { id: 're-3' }); });
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'failed', failureKind: 'transient' });
    const row = fake().rows[0];
    expect(row).toMatchObject({ status: 'failed', error: 'transient:network' });
    advance(6); sync();
    expect(await attemptDelivery(row.id, MAIL)).toMatchObject({ status: 'accepted' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('HTTP 429 is a quota condition: it does not use up an attempt and is retried after the minimum backoff', async () => {
    resend(() => json(429, { message: 'rate limit' }));
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'failed', failureKind: 'quota' });
    const row = fake().rows[0];
    expect(row).toMatchObject({ status: 'failed', attempts: 0, error: 'quota:http_429' });
    expect(Date.parse(String(row.next_attempt_at)) - state.clock.t).toBe(5 * 60_000);
  });

  it('429 with Retry-After (seconds) waits at least that long, never retries early, and keeps the same idempotency key', async () => {
    let limited = true;
    const spy = resend(() => (limited ? json(429, { message: 'daily quota' }, { 'Retry-After': '5400' }) : json(200, { id: 're-q' })));
    await sendEmail(MAIL);
    const row = fake().rows[0];
    expect(row).toMatchObject({ attempts: 0 });
    expect(Date.parse(String(row.next_attempt_at)) - state.clock.t).toBe(90 * 60_000);

    advance(60); sync();
    expect(await attemptDelivery(row.id, MAIL)).toEqual({ status: 'in_progress' }); // still before Retry-After: no claim, no send
    expect(spy).toHaveBeenCalledTimes(1);

    limited = false; advance(31); sync();
    expect(await attemptDelivery(row.id, MAIL)).toMatchObject({ status: 'accepted' });
    expect(fake().rows[0]).toMatchObject({ status: 'accepted', attempts: 1, provider_message_id: 're-q' });
    const keys = spy.mock.calls.map(call => ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual(['order:o1:shipped', 'order:o1:shipped']);
  });

  it('repeated 429 responses never exhaust the six attempts, but the 24-hour window still ends retries', async () => {
    const spy = resend(() => json(429, { message: 'quota' }, { 'Retry-After': '3600' }));
    await sendEmail(MAIL);
    const id = fake().rows[0].id;
    for (let i = 0; i < 10; i += 1) { advance(61); sync(); await attemptDelivery(id, MAIL); }
    expect(fake().rows[0]).toMatchObject({ status: 'failed', attempts: 0 });
    expect(fake().rows[0].next_attempt_at).not.toBeNull();
    advance(24 * 60); sync();
    await attemptDelivery(id, MAIL);
    expect(fake().rows[0].next_attempt_at).toBeNull(); // window over: no more retries
    const calls = spy.mock.calls.length;
    advance(600); sync();
    expect(await attemptDelivery(id, MAIL)).toEqual({ status: 'in_progress' });
    expect(spy).toHaveBeenCalledTimes(calls);
  });

  it('parseRetryAfter reads seconds or an HTTP date, ignores junk and caps at 24 hours; 5xx stays transient', async () => {
    const now = Date.parse('2026-11-10T10:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Tue, 10 Nov 2026 10:10:00 GMT', now)).toBe(600_000);
    expect(parseRetryAfter('Tue, 10 Nov 2026 09:00:00 GMT', now)).toBeUndefined();
    for (const bad of [null, undefined, '', 'soon', '-5', '0']) expect(parseRetryAfter(bad, now)).toBeUndefined();
    expect(parseRetryAfter('999999999', now)).toBe(24 * 60 * 60 * 1000);
    resend(() => json(500, { message: 'boom' }));
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'failed', failureKind: 'transient' });
    expect(fake().rows[0]).toMatchObject({ attempts: 1, error: 'transient:http_500' });
  });

  it('a permanent error (invalid recipient or sender) is never retried', async () => {
    const spy = resend(() => json(422, { message: 'invalid to' }));
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'failed', failureKind: 'permanent' });
    expect(fake().rows[0]).toMatchObject({ status: 'failed', next_attempt_at: null, error: 'permanent:http_422' });
    advance(60 * 12); sync();
    expect(await attemptDelivery(fake().rows[0].id, MAIL)).toEqual({ status: 'in_progress' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a rejected API key (401) keeps the notification without using its attempts, alerts once per day, and sends once the key is fixed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejected = true;
    const spy = resend(() => (rejected ? json(401, { message: 'API key is invalid' }) : json(200, { id: 're-4' })));
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'failed', failureKind: 'auth' });
    const row = fake().rows.find(r => r.kind === 'order_status')!;
    expect(row).toMatchObject({ status: 'failed', attempts: 0, error: 'auth:http_401' });
    expect(Date.parse(String(row.next_attempt_at)) - state.clock.t).toBe(15 * 60_000);

    // the administrator alert: logged, recorded once, and addressed only to the internal address (never a customer)
    expect(err.mock.calls.some(call => String(call[0]).includes('ALERT email_auth'))).toBe(true);
    expect(fake().rows.filter(r => r.kind === 'system_alert')).toHaveLength(1);
    expect(alertCalls(spy)).toHaveLength(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain(API_KEY);

    advance(16); sync();
    await attemptDelivery(row.id, MAIL); // still rejected: the alert is not repeated the same day
    expect(fake().rows.filter(r => r.kind === 'system_alert')).toHaveLength(1);
    expect(alertCalls(spy)).toHaveLength(1);

    rejected = false; advance(16); sync();
    expect(await attemptDelivery(row.id, MAIL)).toMatchObject({ status: 'accepted' });
    expect(fake().rows.find(r => r.id === row.id)).toMatchObject({ status: 'accepted', provider: 'resend' });
    expect(customerCalls(spy).length).toBeGreaterThanOrEqual(3);
  });

  it('a sender or domain Resend does not allow (403) is treated as a configuration error, kept and retried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resend(() => json(403, { message: 'The domain is not verified' }));
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'failed', failureKind: 'auth' });
    expect(fake().rows.find(r => r.kind === 'order_status')).toMatchObject({ attempts: 0, error: 'auth:http_403' });
  });

  it('missing configuration: the notification is kept (skipped_unconfigured), nothing is sent, and it goes out once Resend is configured', async () => {
    state.env = { ...resendEnv(), resend: null };
    const spy = resend();
    expect(await sendEmail(MAIL)).toMatchObject({ status: 'skipped_unconfigured' });
    expect(spy).not.toHaveBeenCalled();
    const row = fake().rows[0];
    expect(row).toMatchObject({ status: 'skipped_unconfigured', attempts: 0 });
    state.env = resendEnv(); advance(16); sync();
    expect(await attemptDelivery(row.id, MAIL)).toMatchObject({ status: 'accepted' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('after 6 definitive failures the notification stops being retried', async () => {
    resend(() => json(500, {}));
    await sendEmail(MAIL);
    // wait exactly until each scheduled retry (5, 15, 45, 120, 360 minutes), staying inside the 24-hour window
    for (let i = 0; i < 10 && fake().rows[0].next_attempt_at; i += 1) { state.clock.t = Date.parse(String(fake().rows[0].next_attempt_at)); sync(); await attemptDelivery(fake().rows[0].id, MAIL); }
    expect(fake().rows[0]).toMatchObject({ status: 'failed', attempts: 6, next_attempt_at: null });
  });
});

describe('before migration 0009 is applied (legacy mode)', () => {
  it('still sends and never crashes; a failure is stored with the old status values only', async () => {
    state.fake = createFakeEmailDb(state.clock, { migrated: false });
    resend(() => json(503, {}));
    const result = await sendEmail(MAIL);
    expect(result.status).toBe('failed');
    const row = fake().rows[0];
    expect(['queued', 'accepted', 'delivered', 'bounced', 'complained', 'failed', 'skipped_unconfigured']).toContain(row.status);
    expect(row.next_attempt_at ?? null).toBeNull(); // the retry columns do not exist yet
  });
});

describe('Resend is the only external provider', () => {
  const src = (path: string) => readFileSync(path, 'utf8');
  it('no Gmail module, import, provider type or credential remains in the sending path', () => {
    const integrations = src('lib/backend/integrations.ts');
    expect(integrations).not.toMatch(/gmail|googleapis/i);
    expect(src('lib/env.ts')).not.toMatch(/gmail/i);
    expect(src('lib/backend/email/retry-supabase.ts')).not.toMatch(/gmail/i);
    expect(src('lib/backend/email/policy.ts')).not.toMatch(/gmail/i);
  });
  it('there is no automatic fallback: only api.resend.com is ever called, even when Resend keeps failing', async () => {
    const spy = resend(() => json(503, {}));
    await sendEmail(MAIL);
    expect(spy.mock.calls.every(call => String(call[0]) === 'https://api.resend.com/emails')).toBe(true);
  });
});
