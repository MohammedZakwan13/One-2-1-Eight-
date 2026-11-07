import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS, MAX_ATTEMPTS, RETRY_WINDOW_MS, backoffMs, decideRetry, isRetryEligible, orderEventEmail, shouldSendConfirmation, type RetryableRow,
} from '@/lib/backend/email/policy';
import { parseTrackingUrl, safeTrackingHref } from '@/lib/tracking-url';

const T0 = new Date('2026-11-10T10:00:00Z');
const minutes = (n: number) => n * 60_000;
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe('retry decisions', () => {
  it('retries a definitive transient failure with exponential backoff', () => {
    expect(decideRetry({ kind: 'transient', attempts: 1, createdAt: T0, now: T0 }).nextAttemptAt).toEqual(at(minutes(5)));
    expect(decideRetry({ kind: 'transient', attempts: 2, createdAt: T0, now: T0 }).nextAttemptAt).toEqual(at(minutes(15)));
    expect(decideRetry({ kind: 'transient', attempts: 3, createdAt: T0, now: T0 }).nextAttemptAt).toEqual(at(minutes(45)));
    expect(backoffMs(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });
  it('stops after the maximum number of attempts', () => {
    const last = decideRetry({ kind: 'transient', attempts: MAX_ATTEMPTS, createdAt: T0, now: T0 });
    expect(last).toMatchObject({ status: 'failed', nextAttemptAt: null });
  });
  it('never retries inside the 24-hour window boundary', () => {
    const now = at(RETRY_WINDOW_MS - minutes(2));
    expect(decideRetry({ kind: 'transient', attempts: 1, createdAt: T0, now }).nextAttemptAt).toBeNull();
  });
  it('NEVER retries an uncertain outcome (the provider may already have sent it)', () => {
    expect(decideRetry({ kind: 'uncertain', attempts: 1, createdAt: T0, now: T0 })).toEqual({ status: 'uncertain', nextAttemptAt: null, countsAttempt: true });
  });
  it('never retries a permanent error', () => {
    expect(decideRetry({ kind: 'permanent', attempts: 1, createdAt: T0, now: T0 })).toMatchObject({ status: 'failed', nextAttemptAt: null });
  });
  it('provider-wide problems (revoked credentials, quota, missing credentials) are retried later without using up the notification', () => {
    expect(decideRetry({ kind: 'auth', attempts: 2, createdAt: T0, now: T0 })).toMatchObject({ status: 'failed', countsAttempt: false, nextAttemptAt: at(minutes(15)) });
    expect(decideRetry({ kind: 'unconfigured', attempts: 1, createdAt: T0, now: T0 })).toMatchObject({ status: 'skipped_unconfigured', countsAttempt: false });
    const quota = decideRetry({ kind: 'quota', attempts: 1, createdAt: T0, now: T0, retryAfterMs: minutes(90) });
    expect(quota).toMatchObject({ countsAttempt: false, nextAttemptAt: at(minutes(90)) });
  });
});

describe('retry eligibility', () => {
  const base: RetryableRow = { kind: 'order_status', status: 'failed', attempts: 1, created_at: T0.toISOString(), next_attempt_at: at(minutes(5)).toISOString() };
  it('picks a failed row only once its retry time is due', () => {
    expect(isRetryEligible(base, at(minutes(4)))).toBe(false);
    expect(isRetryEligible(base, at(minutes(6)))).toBe(true);
  });
  it('never picks accepted, delivered, bounced, complained, uncertain or in-flight rows', () => {
    for (const status of ['accepted', 'delivered', 'bounced', 'complained', 'uncertain', 'sending']) expect(isRetryEligible({ ...base, status }, at(minutes(60))), status).toBe(false);
  });
  it('never picks a permanent failure (no next attempt), an exhausted row or a row older than 24 hours', () => {
    expect(isRetryEligible({ ...base, next_attempt_at: null }, at(minutes(60)))).toBe(false);
    expect(isRetryEligible({ ...base, attempts: MAX_ATTEMPTS }, at(minutes(60)))).toBe(false);
    expect(isRetryEligible({ ...base, next_attempt_at: at(minutes(1)).toISOString() }, at(RETRY_WINDOW_MS + minutes(5)))).toBe(false);
  });
  it('leaves a brand-new queued row to the live request for two minutes, then rescues it', () => {
    const queued = { ...base, status: 'queued', next_attempt_at: null };
    expect(isRetryEligible(queued, at(minutes(1)))).toBe(false);
    expect(isRetryEligible(queued, at(minutes(3)))).toBe(true);
  });
  it('never retries internal alerts', () => { expect(isRetryEligible({ ...base, kind: 'system_alert' }, at(minutes(60)))).toBe(false); });
});

describe('late payment guard', () => {
  it('a late payment on a cancelled order (changed + needs_refund) must NOT produce a confirmation', () => {
    expect(shouldSendConfirmation({ changed: true, payment_status: 'paid', needs_refund: true })).toBe(false);
  });
  it('a normal successful payment still produces exactly the confirmation it always did', () => {
    expect(shouldSendConfirmation({ changed: true, payment_status: 'paid' })).toBe(true);
  });
  it('a repeated settlement (duplicate webhook) or malformed result sends nothing', () => {
    expect(shouldSendConfirmation({ changed: false, payment_status: 'paid' })).toBe(false);
    expect(shouldSendConfirmation(null)).toBe(false);
    expect(shouldSendConfirmation('x')).toBe(false);
  });
});

describe('which order events get a customer email', () => {
  const id = 'o1';
  it('confirmation, processing, packed, shipped, delivered and refunded', () => {
    expect(orderEventEmail({ orderId: id, toStatus: 'confirmed', actorType: 'system' })).toEqual({ kind: 'order_confirmation', dedupeKey: 'order:o1:confirmation' });
    for (const status of ['processing', 'packed', 'shipped', 'delivered', 'refunded']) {
      expect(orderEventEmail({ orderId: id, toStatus: status, actorType: 'admin' })).toEqual({ kind: 'order_status', dedupeKey: `order:o1:${status}` });
    }
  });
  it('admin and customer cancellations are emailed; the system cancelling an unpaid order is not', () => {
    expect(orderEventEmail({ orderId: id, toStatus: 'cancelled', actorType: 'admin' })).not.toBeNull();
    expect(orderEventEmail({ orderId: id, toStatus: 'cancelled', actorType: 'customer' })).not.toBeNull();
    expect(orderEventEmail({ orderId: id, toStatus: 'cancelled', actorType: 'system' })).toBeNull();
  });
  it('pending_payment never produces an email', () => { expect(orderEventEmail({ orderId: id, toStatus: 'pending_payment', actorType: 'system' })).toBeNull(); });
});

describe('tracking link validation', () => {
  it('accepts https links and a blank value (optional)', () => {
    expect(parseTrackingUrl('https://www.delhivery.com/track/package/123')).toEqual({ ok: true, url: 'https://www.delhivery.com/track/package/123' });
    expect(parseTrackingUrl('   ')).toEqual({ ok: true, url: null });
    expect(parseTrackingUrl(undefined)).toEqual({ ok: true, url: null });
  });
  it('rejects http, javascript:, data:, ftp, credentials, bare words, single-label hosts and over-long links', () => {
    for (const bad of ['http://courier.example/t/1', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example/a', 'https://user:pw@courier.example/t', 'courier.example/track', 'https://localhost/x', `https://courier.example/${'a'.repeat(500)}`]) {
      expect(parseTrackingUrl(bad).ok, bad).toBe(false);
    }
  });
  it('the email renderer only ever uses a safe link', () => {
    expect(safeTrackingHref('https://courier.example/t/9')).toBe('https://courier.example/t/9');
    expect(safeTrackingHref('javascript:alert(1)')).toBeNull();
    expect(safeTrackingHref('http://courier.example')).toBeNull();
  });
});

describe('worker execution budget (D3)', () => {
  it('allows a new send only while a worst-case send still fits inside 40 seconds', async () => {
    const { canStartAnotherSend, WORKER_BUDGET_MS, SEND_WORST_CASE_MS } = await import('@/lib/backend/email/policy');
    expect(WORKER_BUDGET_MS).toBe(40_000);
    expect(canStartAnotherSend(0)).toBe(true);
    expect(canStartAnotherSend(WORKER_BUDGET_MS - SEND_WORST_CASE_MS)).toBe(true);
    expect(canStartAnotherSend(WORKER_BUDGET_MS - SEND_WORST_CASE_MS + 1)).toBe(false);
    expect(canStartAnotherSend(WORKER_BUDGET_MS)).toBe(false);
  });
  it('the worst-case send reserve stays above the Resend request timeout (8 s) with slack for the database calls', async () => {
    const { SEND_WORST_CASE_MS } = await import('@/lib/backend/email/policy');
    expect(SEND_WORST_CASE_MS).toBe(18_000);
  });
});

describe('a notice is never sent after a later status (D2)', () => {
  it('processing, packed and shipped are stale once the order is delivered, refunded or cancelled', async () => {
    const { isSupersededStatus } = await import('@/lib/backend/email/policy');
    for (const stale of ['processing', 'packed', 'shipped']) {
      for (const now of ['delivered', 'refunded', 'cancelled']) expect(isSupersededStatus(stale, now), `${stale} after ${now}`).toBe(true);
    }
    expect(isSupersededStatus('processing', 'packed')).toBe(true);
    expect(isSupersededStatus('packed', 'shipped')).toBe(true);
  });
  it('the current status, earlier-than-current checks, cancellations and confirmations are never stale', async () => {
    const { isSupersededStatus } = await import('@/lib/backend/email/policy');
    expect(isSupersededStatus('delivered', 'delivered')).toBe(false);
    expect(isSupersededStatus('packed', 'processing')).toBe(false);
    expect(isSupersededStatus('cancelled', 'delivered')).toBe(false);
    expect(isSupersededStatus('cancelled', 'cancelled')).toBe(false);
    expect(isSupersededStatus('confirmation', 'delivered')).toBe(false);
    expect(isSupersededStatus('unknown_status', 'delivered')).toBe(false);
  });
});
