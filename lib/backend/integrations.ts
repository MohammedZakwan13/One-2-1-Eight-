import 'server-only';
import { createHmac } from 'node:crypto';
import { getServerEnv } from '@/lib/env';
import { HttpError, db, safeEqual } from '@/lib/backend/core';
import { logOtp } from '@/lib/backend/otp';
import { decideRetry, type FailureKind } from '@/lib/backend/email/policy';
import { safeTrackingHref } from '@/lib/tracking-url';

// ───────────── Resend (outbound email) ─────────────

export type EmailResult = {
  status: 'accepted' | 'failed' | 'skipped_unconfigured' | 'already_sent' | 'uncertain' | 'in_progress';
  providerMessageId?: string;
  /** Present when the attempt failed, so a retry run can stop early when the provider itself is down. */
  failureKind?: FailureKind;
};

/** Local SMTP capture. `accepted` here means Mailpit took the message, never that a real inbox received it. */
async function sendViaMailpit(mail: { host: string; port: number; from: string }, input: { to: string; subject: string; html: string; text: string }): Promise<string> {
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({ host: mail.host, port: mail.port, secure: false, ignoreTLS: true, connectionTimeout: 4000, socketTimeout: 6000 });
  const info = await transport.sendMail({ from: mail.from, to: input.to, subject: input.subject, html: input.html, text: input.text });
  return String(info.messageId);
}
export type EmailInput = { kind: string; to: string; subject: string; html: string; text: string; dedupeKey: string; entityType?: string; entityId?: string };

type LogRow = { id: string; status: string; attempts?: number; created_at?: string };
type Provider = 'resend' | 'mailpit';
type Outcome = { ok: true; provider: Provider; messageId: string } | { ok: false; provider: Provider | 'none'; kind: FailureKind; code: string; retryAfterMs?: number };

/** `undefined` until we learn whether migration 0009 (claim_email_log + retry columns) is applied; then cached for the process. */
let retryQueueReady: boolean | undefined;
const missingObject = (message: string | undefined) => /does not exist|schema cache|PGRST202|42883|42P01|42703/.test(message ?? '');
export const emailRetryQueueReady = () => retryQueueReady;
export const resetEmailQueueProbe = () => { retryQueueReady = undefined; };

/** Atomically claims a log row for ONE worker. `row` is null when someone else holds it or it is not claimable. */
async function claim(logId: string): Promise<{ row: Record<string, unknown> | null; legacy: boolean }> {
  if (retryQueueReady === false) return { row: { id: logId }, legacy: true };
  const { data, error } = await db().rpc('claim_email_log', { p_id: logId });
  if (error) {
    if (missingObject(error.message)) { retryQueueReady = false; return { row: { id: logId }, legacy: true }; }
    throw new Error(error.message);
  }
  retryQueueReady = true;
  return { row: (data as Record<string, unknown> | null) ?? null, legacy: false };
}

/** `Retry-After` is either whole seconds or an HTTP date. Returns milliseconds from now, or undefined when absent / unusable. Capped at 24 h. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, 24 * 60 * 60 * 1000);
}

async function deliver(input: EmailInput): Promise<Outcome> {
  const env = getServerEnv();
  if (env.mailpit) {
    try { return { ok: true, provider: 'mailpit', messageId: await sendViaMailpit(env.mailpit, input) }; }
    catch { return { ok: false, provider: 'mailpit', kind: 'transient', code: 'mailpit_unreachable' }; }
  }
  if (!env.resend) return { ok: false, provider: 'none', kind: 'unconfigured', code: 'resend_not_configured' };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resend.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.dedupeKey.slice(0, 256) },
      body: JSON.stringify({ from: env.resend.from, to: [input.to], subject: input.subject, html: input.html, text: input.text, ...(env.emailReplyTo ? { reply_to: env.emailReplyTo } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => ({})) as { id?: string };
    if (response.ok && payload.id) return { ok: true, provider: 'resend', messageId: payload.id };
    const status = response.status;
    // Resend honours the Idempotency-Key, so re-sending after any ambiguous outcome cannot duplicate the message.
    // 429 (rate limit or the plan's daily / monthly quota) is a provider-wide condition, not this notification's fault: it does not use up an attempt.
    if (status === 429) return { ok: false, provider: 'resend', kind: 'quota', code: 'http_429', retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) };
    if (status >= 500) return { ok: false, provider: 'resend', kind: 'transient', code: `http_${status}` };
    if (status === 401 || status === 403) return { ok: false, provider: 'resend', kind: 'auth', code: `http_${status}` };
    return { ok: false, provider: 'resend', kind: 'permanent', code: `http_${status}` };
  } catch {
    return { ok: false, provider: 'resend', kind: 'transient', code: 'network' };
  }
}

async function record(logId: string, claimedRow: Record<string, unknown> | null, legacy: boolean, createdAt: Date, outcome: Outcome): Promise<EmailResult> {
  const now = new Date();
  const patch: Record<string, unknown> = { updated_at: now.toISOString() };
  let result: EmailResult;
  if (outcome.ok) {
    patch.status = 'accepted'; patch.error = null;
    patch.provider_message_id = (outcome.provider === 'resend' ? outcome.messageId : `${outcome.provider}:${outcome.messageId}`).slice(0, 200);
    if (!legacy) { patch.provider = outcome.provider; patch.next_attempt_at = null; }
    result = { status: 'accepted', providerMessageId: outcome.messageId };
  } else {
    const attempts = Number(claimedRow?.attempts ?? 1);
    const decision = decideRetry({ kind: outcome.kind, attempts, createdAt, now, retryAfterMs: outcome.retryAfterMs });
    // Before 0009 the status CHECK only knows the old values, so an uncertain outcome is stored as 'failed' with its reason in `error`.
    patch.status = legacy && decision.status === 'uncertain' ? 'failed' : decision.status;
    patch.error = `${outcome.kind}:${outcome.code}`.slice(0, 300);
    if (!legacy) {
      patch.provider = outcome.provider === 'none' ? null : outcome.provider;
      patch.next_attempt_at = decision.nextAttemptAt?.toISOString() ?? null;
      if (!decision.countsAttempt) patch.attempts = Math.max(0, attempts - 1);
    }
    result = { status: decision.status === 'uncertain' ? 'uncertain' : decision.status === 'skipped_unconfigured' ? 'skipped_unconfigured' : 'failed', failureKind: outcome.kind };
  }
  const query = db().from('email_log').update(patch).eq('id', logId);
  const { error } = await (legacy ? query : query.eq('status', 'sending'));
  if (error) console.error('[email] could not record outcome', { logId, code: error.code });
  return result;
}

/**
 * One delivery attempt for an existing `email_log` row: claim (only one worker may hold it) → provider → record the outcome.
 * Never throws; never sends when the row was already accepted, is uncertain, or is held by another worker.
 */
export async function attemptDelivery(logId: string, input: EmailInput, createdAt = new Date()): Promise<EmailResult> {
  let claimed: Awaited<ReturnType<typeof claim>>;
  try { claimed = await claim(logId); } catch (error) { console.error('[email] claim failed', error instanceof Error ? error.message : 'error'); return { status: 'failed', failureKind: 'transient' }; }
  if (!claimed.row) return { status: 'in_progress' };
  const started = claimed.row.created_at ? new Date(String(claimed.row.created_at)) : createdAt;
  let outcome: Outcome;
  try { outcome = await deliver(input); }
  catch { outcome = { ok: false, provider: 'none', kind: 'uncertain', code: 'unexpected_error' }; }
  const result = await record(logId, claimed.row, claimed.legacy, started, outcome);
  console.warn('[email] attempt', { kind: input.kind, attempt: Number(claimed.row.attempts ?? 1), provider: outcome.provider, outcome: outcome.ok ? 'accepted' : outcome.kind, code: outcome.ok ? undefined : outcome.code });
  if (!outcome.ok && outcome.kind === 'auth' && outcome.provider === 'resend') {
    await alertAdmin('email_auth', 'Email sending has stopped', `Customer emails are paused: Resend rejected the API key or the sender (${outcome.code}). The key may have been revoked or restricted, or the sending domain is not verified. Customer notifications are kept and retried automatically (for up to 24 hours from the order) once RESEND_API_KEY / EMAIL_FROM are corrected in the server configuration.`);
  }
  return result;
}

/**
 * Records and sends one email. Never throws: a failed or unconfigured provider must not undo the order/lead that triggered it.
 * Idempotent per `dedupeKey`: a message that was already accepted is never sent again, and concurrent callers cannot both send it.
 * `accepted` means the provider took the message; delivery (where the provider reports it) is recorded later by its webhook.
 */
export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  try {
    const base = { kind: input.kind, to_email: input.to, subject: input.subject, entity_type: input.entityType ?? null, entity_id: input.entityId ?? null, dedupe_key: input.dedupeKey };
    const inserted = await db().from('email_log').insert({ ...base, status: 'queued' }).select('id').single();
    let logId = inserted.data?.id as string | undefined;
    if (inserted.error) {
      if (inserted.error.code !== '23505') throw new Error(inserted.error.message);
      const existing = await db().from('email_log').select('id, status').eq('dedupe_key', input.dedupeKey).single();
      const row = existing.data as LogRow | null;
      if (row && ['accepted', 'delivered', 'bounced', 'complained'].includes(row.status)) return { status: 'already_sent' };
      if (row?.status === 'uncertain') return { status: 'uncertain' };
      logId = row?.id;
    }
    if (!logId) return { status: 'failed' };
    return await attemptDelivery(logId, input);
  } catch (error) {
    console.error('[email] send failed', error instanceof Error ? error.message : error);
    return { status: 'failed' };
  }
}

/**
 * Internal alert to the administrator, at most once per day per kind. It never goes to a customer. It is always written to the server log
 * and to email_log (kind system_alert). It is also emailed to INTERNAL_NOTIFICATION_EMAIL through Resend when that is configured, which
 * cannot succeed if Resend itself rejects the key, so the log line and the `tripped` field of the retry endpoint are the dependable signals.
 */
export async function alertAdmin(kind: 'email_auth' | 'email_stalled', subject: string, body: string): Promise<void> {
  try {
    const env = getServerEnv();
    const key = `alert:${kind}:${new Date().toISOString().slice(0, 10)}`;
    const inserted = await db().from('email_log').insert({ kind: 'system_alert', to_email: env.internalNotificationEmail ?? 'unconfigured', subject, dedupe_key: key, status: 'queued' }).select('id').single();
    if (inserted.error) return; // already alerted today (or the log is unavailable)
    console.error(`[email] ALERT ${kind}: ${subject}`);
    const logId = inserted.data!.id as string;
    if (!env.resend || !env.internalNotificationEmail) {
      await db().from('email_log').update({ status: 'skipped_unconfigured', error: 'no internal alert channel configured', updated_at: new Date().toISOString() }).eq('id', logId);
      return;
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resend.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: env.resend.from, to: [env.internalNotificationEmail], subject: `[ONE 2 1 EIGHT] ${subject}`, text: body }),
      signal: AbortSignal.timeout(8000),
    });
    await db().from('email_log').update({ status: response.ok ? 'accepted' : 'failed', provider: 'resend', error: response.ok ? null : `http_${response.status}`, updated_at: new Date().toISOString() }).eq('id', logId);
  } catch (error) {
    console.error('[email] alert failed', error instanceof Error ? error.message : 'error');
  }
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export const inr = (amount: number) => `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const shell = (title: string, body: string) =>
  `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111"><h2 style="letter-spacing:.08em">ONE 2 1 EIGHT</h2><h3>${esc(title)}</h3>${body}<p style="color:#777;font-size:12px;margin-top:28px">This is an automated message about your order.</p></div>`;

type OrderMail = { trackUrl?: string; id: string; number: string; status: string; total: number; contact: { name: string; email: string }; lines: { name: string; size: string; quantity: number }[]; paymentMethod: string; shipment: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null } | null };

const STATUS_COPY: Record<string, string> = {
  confirmed: 'Your order is confirmed.', processing: 'We are preparing your order.', packed: 'Your order is packed.', shipped: 'Your order is on its way.',
  delivered: 'Your order has been delivered.', cancelled: 'Your order has been cancelled.', refunded: 'Your order has been marked as refunded.',
};

export function orderEmail(order: OrderMail, kind: 'confirmation' | 'status') {
  const items = order.lines.map(line => `<li>${esc(line.name)} (${esc(line.size)}) × ${line.quantity}</li>`).join('');
  const headline = kind === 'confirmation' ? `Thank you, ${order.contact.name.split(' ')[0]}. We received your order.` : STATUS_COPY[order.status] ?? `Order status: ${order.status}`;
  const shipment = order.shipment;
  const trackingHref = safeTrackingHref(shipment?.trackingUrl);
  const hasShipment = Boolean(shipment && (shipment.carrier || shipment.trackingNumber || trackingHref));
  const track = hasShipment && shipment
    ? `<p>Courier: ${esc(shipment.carrier ?? '—')}${shipment.trackingNumber ? `<br>Tracking: ${esc(shipment.trackingNumber)}` : ''}</p>${trackingHref ? `<p><a href="${esc(trackingHref)}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;text-decoration:none;letter-spacing:.06em">TRACK YOUR PARCEL</a></p>` : ''}` : '';
  const html = shell(`Order ${order.number}`, `<p>${esc(headline)}</p><ul>${items}</ul><p><strong>Total ${inr(order.total)}</strong> · ${order.paymentMethod === 'cod' ? 'Pay on delivery' : 'Online payment'}</p>${track}${order.trackUrl ? `<p><a href="${esc(order.trackUrl)}">View or track your order</a></p>` : ''}`);
  const trackText = hasShipment && shipment ? `\nCourier: ${shipment.carrier ?? '-'}${shipment.trackingNumber ? `\nTracking: ${shipment.trackingNumber}` : ''}${trackingHref ? `\nTrack your parcel: ${trackingHref}` : ''}` : '';
  const text = `${headline}\nOrder ${order.number}\n${order.lines.map(line => `${line.name} (${line.size}) x ${line.quantity}`).join('\n')}\nTotal ${inr(order.total)}${trackText}${order.trackUrl ? `\nTrack your order: ${order.trackUrl}` : ''}`;
  return { subject: kind === 'confirmation' ? `Order ${order.number} received — ONE 2 1 EIGHT` : `Order ${order.number}: ${order.status.replace(/_/g, ' ')}`, html, text };
}

export const sendOrderEmail = (order: OrderMail, kind: 'confirmation' | 'status') => {
  const content = orderEmail(order, kind);
  return sendEmail({ kind: `order_${kind}`, to: order.contact.email, ...content, dedupeKey: `order:${order.id}:${kind === 'confirmation' ? 'confirmation' : order.status}`, entityType: 'order', entityId: order.id });
};

export type LeadMail = { id: string; name: string; email: string; phone: string; type: string; quantity: string; message: string };
export const leadInternalEmail = (lead: LeadMail) => {
  const details = `Name: ${lead.name}\nEmail: ${lead.email}\nPhone: ${lead.phone}\nType: ${lead.type}\nQuantity: ${lead.quantity}\n\n${lead.message}`;
  return { subject: `New enquiry: ${lead.type} — ${lead.name}`, html: shell('New bulk / custom enquiry', `<pre style="white-space:pre-wrap;font-family:inherit">${esc(details)}</pre>`), text: details };
};
export const leadAckEmail = (lead: LeadMail) => ({ subject: 'We received your enquiry — ONE 2 1 EIGHT', html: shell('Thanks for reaching out', `<p>Hi ${esc(lead.name)}, we have your enquiry and will reply soon.</p>`), text: `Hi ${lead.name}, we have your enquiry and will reply soon.` });
export async function sendLeadEmails(lead: LeadMail) {
  const { internalNotificationEmail } = getServerEnv();
  const tasks: Promise<EmailResult>[] = [];
  if (internalNotificationEmail) tasks.push(sendEmail({ kind: 'lead_internal', to: internalNotificationEmail, ...leadInternalEmail(lead), dedupeKey: `lead:${lead.id}:internal`, entityType: 'lead', entityId: lead.id }));
  tasks.push(sendEmail({ kind: 'lead_ack', to: lead.email, ...leadAckEmail(lead), dedupeKey: `lead:${lead.id}:ack`, entityType: 'lead', entityId: lead.id }));
  return Promise.all(tasks);
}

/** Verifies a Resend (Svix) webhook signature. Returns false on any mismatch or stale timestamp (replay window 5 min). */
export function verifyResendWebhook(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, rawBody: string): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(headers.timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest('base64');
  return headers.signature.split(' ').some(part => { const [, value] = part.split(','); return Boolean(value) && safeEqual(value, expected); });
}

// ───────────── Razorpay (payments) ─────────────

export async function createRazorpayOrder(amountInr: number, receipt: string): Promise<{ id: string }> {
  const { razorpay } = getServerEnv();
  if (!razorpay) throw new HttpError(409, 'payment_unavailable', 'Online payment is not available right now.');
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${razorpay.keyId}:${razorpay.keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(amountInr * 100), currency: 'INR', receipt: receipt.slice(0, 40) }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({})) as { id?: string };
  if (!response.ok || !payload.id) throw new HttpError(502, 'payment_provider_error', 'We could not start the payment. Please try again.');
  return { id: payload.id };
}

const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');
export function verifyRazorpayPayment(providerOrderId: string, paymentId: string, signature: string): boolean {
  const { razorpay } = getServerEnv();
  return Boolean(razorpay) && safeEqual(hmacHex(razorpay!.keySecret, `${providerOrderId}|${paymentId}`), signature);
}
export function verifyRazorpayWebhook(rawBody: string, signature: string): boolean {
  const { razorpay } = getServerEnv();
  return Boolean(razorpay?.webhookSecret) && safeEqual(hmacHex(razorpay!.webhookSecret!, rawBody), signature);
}

// ───────────── MSG91 (customer OTP SMS) ─────────────

/**
 * MSG91 OTP Widget (Web SDK, custom UI). The BROWSER sends and verifies the code with MSG91; it then receives an access token. A browser
 * "success" callback proves nothing, so this server call to MSG91's verifyAccessToken (dedicated server-side authkey, never sent to the browser)
 * is what authenticates. Returns the 10-digit mobile MSG91 says was verified, or throws:
 *  422 otp_invalid  = MSG91 answered and did not confirm the token,   502 sms_provider_error = no usable answer (network, 5xx, non-JSON),
 *  503 sms_not_configured, 422 when MSG91 confirms but does not say which number (fails closed: we never log a user in on the browser's word).
 * Neither the authkey nor the token is logged or placed in an error returned to the browser.
 */
export async function verifyOtpAccessToken(accessToken: string): Promise<string> {
  const { msg91 } = getServerEnv();
  if (!msg91) throw new HttpError(503, 'sms_not_configured', 'Sign-in by SMS is not available yet.');
  const unavailable = () => new HttpError(502, 'sms_provider_error', 'We could not verify the code. Please try again.');
  let response: Response;
  try {
    response = await fetch('https://control.msg91.com/api/v5/widget/verifyAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ authkey: msg91.authKey, 'access-token': accessToken }), signal: AbortSignal.timeout(8000),
    });
  } catch (cause) {
    logOtp('provider_unavailable', { stage: 'network', error: cause instanceof Error ? cause.name : 'unknown' });
    throw unavailable();
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.status >= 500 || !payload || typeof payload !== 'object') { logOtp('provider_unavailable', { stage: 'response', status: response.status, jsonBody: Boolean(payload && typeof payload === 'object') }); throw unavailable(); }
  if (!response.ok || payload.type !== 'success') {
    logOtp('provider_rejected', { status: response.status, type: typeof payload.type === 'string' ? payload.type.slice(0, 20) : 'none' });
    throw new HttpError(422, 'otp_invalid', 'That code could not be verified. Request a new one.');
  }
  // Seen live: a 2-key body, { type: "success", message: "<mobile>" }. MSG91 names the verified identifier in `message`; nothing else (and nothing inside the JWT) is trusted for identity.
  const identity = mobileFromVerifyMessage(payload.message);
  if (!('mobile' in identity)) { logOtp('no_verified_mobile', { status: response.status, type: 'success', messageKind: identity.kind, topLevelKeys: Object.keys(payload).length }); throw new HttpError(422, 'otp_invalid', 'That code could not be verified. Request a new one.'); }
  return identity.mobile;
}

/**
 * The verified identifier MSG91 returns in `message`, as a canonical 10-digit Indian mobile (6-9 first digit). Accepts only a string made of digits with an optional
 * leading "+", spaces or hyphens, and only as 10 digits or "91" + 10 digits. Status text ("OTP verified successfully"), other lengths, numbers and missing values
 * are rejected. The value itself is never logged; callers get only a category.
 */
export function mobileFromVerifyMessage(message: unknown): { mobile: string } | { kind: 'missing' | 'non_string' | 'text' | 'invalid_number' } {
  if (message === undefined || message === null || message === '') return { kind: 'missing' };
  if (typeof message !== 'string') return { kind: 'non_string' };
  const trimmed = message.trim();
  if (!/^\+?[\d\s-]+$/.test(trimmed)) return { kind: 'text' };
  const digits = trimmed.replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(national) ? { mobile: national } : { kind: 'invalid_number' };
}

// ───────────── return / refund notifications ─────────────

export type ReturnMail = { id: string; number: string; orderNumber: string; status: string; to: string; name: string; trackUrl: string; refundAmount?: number | null; refundReference?: string | null; note?: string | null };
const RETURN_COPY: Record<string, string> = {
  requested: 'We received your return request and will review it shortly.',
  approved: 'Your return was approved. Please keep the item unused with its tags; we will contact you with pick-up or drop-off details.',
  rejected: 'Your return request could not be approved.',
  received: 'We received your returned item and are inspecting it.',
  refund_pending: 'Your refund is being processed. It is not complete yet.',
  completed: 'Your refund has been completed.',
};
export function returnEmail(ret: ReturnMail) {
  const headline = RETURN_COPY[ret.status] ?? `Return status: ${ret.status}`;
  const extra = [ret.note ? `Note: ${ret.note}` : '', ret.status === 'completed' && ret.refundAmount ? `Refunded: ${inr(ret.refundAmount)}${ret.refundReference ? ` (ref ${ret.refundReference})` : ''}` : ''].filter(Boolean);
  const html = shell(`Return ${ret.number}`, `<p>Hi ${esc(ret.name.split(' ')[0])}, ${esc(headline)}</p><p>Order ${esc(ret.orderNumber)}</p>${extra.map(line => `<p>${esc(line)}</p>`).join('')}<p><a href="${esc(ret.trackUrl)}">View your order and return</a></p>`);
  const text = [headline, `Return ${ret.number} (order ${ret.orderNumber})`, ...extra, `View: ${ret.trackUrl}`].join('\n');
  return { subject: `Return ${ret.number}: ${ret.status.replace(/_/g, ' ')}`, html, text };
}
export const sendReturnEmail = (ret: ReturnMail) => sendEmail({ kind: 'return_status', to: ret.to, ...returnEmail(ret), dedupeKey: `return:${ret.id}:${ret.status}`, entityType: 'return', entityId: ret.id });
