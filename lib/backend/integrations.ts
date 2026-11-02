import 'server-only';
import { createHmac } from 'node:crypto';
import { getServerEnv } from '@/lib/env';
import { HttpError, db, safeEqual } from '@/lib/backend/core';
import { logOtp } from '@/lib/backend/otp';

// ───────────── Resend (outbound email) ─────────────

export type EmailResult = { status: 'accepted' | 'failed' | 'skipped_unconfigured' | 'already_sent'; providerMessageId?: string };

/** Local SMTP capture. `accepted` here means Mailpit took the message, never that a real inbox received it. */
async function sendViaMailpit(mail: { host: string; port: number; from: string }, input: { to: string; subject: string; html: string; text: string }): Promise<string> {
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({ host: mail.host, port: mail.port, secure: false, ignoreTLS: true, connectionTimeout: 4000, socketTimeout: 6000 });
  const info = await transport.sendMail({ from: mail.from, to: input.to, subject: input.subject, html: input.html, text: input.text });
  return String(info.messageId);
}
type EmailInput = { kind: string; to: string; subject: string; html: string; text: string; dedupeKey: string; entityType?: string; entityId?: string };

/**
 * Sends one email through Resend and records the outcome in `email_log`. Never throws: a failed or
 * unconfigured provider must not undo the order/lead that triggered it. `accepted` means Resend accepted
 * the message — delivery is recorded later by the Resend webhook.
 */
export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  try {
    const { resend, mailpit } = getServerEnv();
    const base = { kind: input.kind, to_email: input.to, subject: input.subject, entity_type: input.entityType ?? null, entity_id: input.entityId ?? null, dedupe_key: input.dedupeKey };
    const inserted = await db().from('email_log').insert({ ...base, status: 'queued' }).select('id').single();
    let logId = inserted.data?.id as string | undefined;
    if (inserted.error) {
      if (inserted.error.code !== '23505') throw new Error(inserted.error.message);
      const existing = await db().from('email_log').select('id, status').eq('dedupe_key', input.dedupeKey).single();
      if (existing.data && ['accepted', 'delivered'].includes(existing.data.status)) return { status: 'already_sent' };
      logId = existing.data?.id;
    }
    const update = (patch: Record<string, unknown>) => db().from('email_log').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', logId!);
    if (mailpit) {
      try {
        const messageId = await sendViaMailpit(mailpit, input);
        await update({ status: 'accepted', provider_message_id: `mailpit:${messageId}`.slice(0, 200), error: null });
        return { status: 'accepted', providerMessageId: messageId };
      } catch (cause) {
        await update({ status: 'failed', error: `Mailpit unreachable: ${cause instanceof Error ? cause.message : 'error'}`.slice(0, 300) });
        return { status: 'failed' };
      }
    }
    if (!resend) { await update({ status: 'skipped_unconfigured', error: 'RESEND_API_KEY / EMAIL_FROM not set' }); return { status: 'skipped_unconfigured' }; }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resend.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.dedupeKey.slice(0, 256) },
      body: JSON.stringify({ from: resend.from, to: [input.to], subject: input.subject, html: input.html, text: input.text }),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !payload.id) {
      await update({ status: 'failed', error: (payload.message ?? `HTTP ${response.status}`).slice(0, 300) });
      return { status: 'failed' };
    }
    await update({ status: 'accepted', provider_message_id: payload.id, error: null });
    return { status: 'accepted', providerMessageId: payload.id };
  } catch (error) {
    console.error('[email] send failed', error instanceof Error ? error.message : error);
    return { status: 'failed' };
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
  const track = order.shipment?.trackingNumber
    ? `<p>Carrier: ${esc(order.shipment.carrier ?? '—')}<br>Tracking: ${order.shipment.trackingUrl ? `<a href="${esc(order.shipment.trackingUrl)}">${esc(order.shipment.trackingNumber)}</a>` : esc(order.shipment.trackingNumber)}</p>` : '';
  const html = shell(`Order ${order.number}`, `<p>${esc(headline)}</p><ul>${items}</ul><p><strong>Total ${inr(order.total)}</strong> · ${order.paymentMethod === 'cod' ? 'Pay on delivery' : 'Online payment'}</p>${track}${order.trackUrl ? `<p><a href="${esc(order.trackUrl)}">View or track your order</a></p>` : ''}`);
  const text = `${headline}\nOrder ${order.number}\n${order.lines.map(line => `${line.name} (${line.size}) x ${line.quantity}`).join('\n')}\nTotal ${inr(order.total)}${order.shipment?.trackingNumber ? `\nTracking: ${order.shipment.trackingNumber} ${order.shipment.trackingUrl ?? ''}` : ''}${order.trackUrl ? `
Track your order: ${order.trackUrl}` : ''}`;
  return { subject: kind === 'confirmation' ? `Order ${order.number} received — ONE 2 1 EIGHT` : `Order ${order.number}: ${order.status.replace(/_/g, ' ')}`, html, text };
}

export const sendOrderEmail = (order: OrderMail, kind: 'confirmation' | 'status') => {
  const content = orderEmail(order, kind);
  return sendEmail({ kind: `order_${kind}`, to: order.contact.email, ...content, dedupeKey: `order:${order.id}:${kind === 'confirmation' ? 'confirmation' : order.status}`, entityType: 'order', entityId: order.id });
};

type LeadMail = { id: string; name: string; email: string; phone: string; type: string; quantity: string; message: string };
export async function sendLeadEmails(lead: LeadMail) {
  const { resend } = getServerEnv();
  const details = `Name: ${lead.name}\nEmail: ${lead.email}\nPhone: ${lead.phone}\nType: ${lead.type}\nQuantity: ${lead.quantity}\n\n${lead.message}`;
  const tasks: Promise<EmailResult>[] = [];
  if (resend?.internalEmail) {
    tasks.push(sendEmail({ kind: 'lead_internal', to: resend.internalEmail, subject: `New enquiry: ${lead.type} — ${lead.name}`, html: shell('New bulk / custom enquiry', `<pre style="white-space:pre-wrap;font-family:inherit">${esc(details)}</pre>`), text: details, dedupeKey: `lead:${lead.id}:internal`, entityType: 'lead', entityId: lead.id }));
  }
  tasks.push(sendEmail({ kind: 'lead_ack', to: lead.email, subject: 'We received your enquiry — ONE 2 1 EIGHT', html: shell('Thanks for reaching out', `<p>Hi ${esc(lead.name)}, we have your enquiry and will reply soon.</p>`), text: `Hi ${lead.name}, we have your enquiry and will reply soon.`, dedupeKey: `lead:${lead.id}:ack`, entityType: 'lead', entityId: lead.id }));
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
