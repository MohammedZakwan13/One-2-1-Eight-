import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvError, getServerEnv, resetServerEnvCache } from '@/lib/env';
import { orderEmail } from '@/lib/backend/integrations';
import { updateOrderStatusSchema } from '@/lib/api/schemas';
import { orderContactMailto } from '@/lib/format';

const retry = vi.hoisted(() => ({ run: vi.fn(async () => ({ swept: 0, reconciled: 1, considered: 1, accepted: 1, failed: 0, uncertain: 0, skipped: 0, inProgress: 0, gaveUp: 0, tripped: null, queueReady: true, migrationRequired: false })) }));
vi.mock('@/lib/backend/email/retry-supabase', () => ({ runSupabaseEmailRetry: retry.run }));

const src = (path: string) => readFileSync(path, 'utf8');
const BASE = { APP_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a' };
const EMAIL_KEYS = ['EMAIL_PROVIDER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'EMAIL_REPLY_TO', 'RESEND_WEBHOOK_SECRET', 'EMAIL_RETRY_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM', 'INTERNAL_NOTIFICATION_EMAIL'];
const saved = { ...process.env };
beforeEach(() => { for (const key of EMAIL_KEYS) delete process.env[key]; Object.assign(process.env, BASE); resetServerEnvCache(); });
afterEach(() => { process.env = { ...saved }; resetServerEnvCache(); vi.restoreAllMocks(); });
const withEnv = (extra: Record<string, string>) => { Object.assign(process.env, extra); resetServerEnvCache(); return getServerEnv(); };

describe('email configuration', () => {
  it('Resend with its API key and the planned sender, Reply-To and internal address', () => {
    const env = withEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'ONE 2 1 EIGHT <orders@send.one21eight.com>', EMAIL_REPLY_TO: 'one21eight@gmail.com', INTERNAL_NOTIFICATION_EMAIL: 'one21eight@gmail.com' });
    expect(env.emailProvider).toBe('resend');
    expect(env.resend).toMatchObject({ apiKey: 're_x', from: 'ONE 2 1 EIGHT <orders@send.one21eight.com>' });
    expect(env.emailReplyTo).toBe('one21eight@gmail.com');
    expect(env.internalNotificationEmail).toBe('one21eight@gmail.com');
  });
  it('Resend without credentials is allowed (emails are kept until they exist) and exposes no provider', () => {
    const env = withEnv({ EMAIL_PROVIDER: 'resend' });
    expect(env.resend).toBeNull();
  });
  it('the API key and the sender must be set together', () => {
    process.env.RESEND_API_KEY = 're_x'; resetServerEnvCache();
    expect(() => getServerEnv()).toThrow(EnvError);
  });
  it('Gmail is no longer a provider: EMAIL_PROVIDER=gmail is refused, and GMAIL_* settings are ignored', () => {
    process.env.EMAIL_PROVIDER = 'gmail'; resetServerEnvCache();
    expect(() => getServerEnv()).toThrow();
    delete process.env.EMAIL_PROVIDER;
    const env = withEnv({ GMAIL_CLIENT_ID: 'cid' });
    expect(env).not.toHaveProperty('gmail');
    expect(env.emailProvider).toBe('resend');
  });
  it('resend remains the default provider and keeps working', () => {
    const env = withEnv({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'ONE 2 1 EIGHT <orders@example.com>' });
    expect(env.emailProvider).toBe('resend');
    expect(env.resend).toMatchObject({ apiKey: 're_x' });
  });
  it('mailpit is still refused in production; the retry secret must be long enough', () => {
    expect(() => withEnv({ EMAIL_PROVIDER: 'mailpit', APP_ENV: 'production' })).toThrow();
    process.env.APP_ENV = 'development'; process.env.EMAIL_RETRY_SECRET = 'short'; resetServerEnvCache();
    expect(() => getServerEnv()).toThrow();
  });
  it('.env.example documents only NAMES for the new variables (no values)', () => {
    const example = src('.env.example');
    expect(example).toMatch(/^# EMAIL_RETRY_SECRET=$/m);
    expect(example).toMatch(/^RESEND_API_KEY=$/m);
    expect(example).toMatch(/^RESEND_WEBHOOK_SECRET=$/m);
    expect(example).toMatch(/^EMAIL_FROM=ONE 2 1 EIGHT <orders@send\.one21eight\.com>$/m);
    expect(example).toMatch(/^# EMAIL_REPLY_TO=one21eight@gmail\.com$/m);
    expect(example).not.toMatch(/GMAIL_|googleapis/);
  });
});

describe('retry endpoint security', () => {
  const SECRET = 'a-very-long-random-retry-secret-0123456789';
  const call = async (header?: string) => {
    const { POST } = await import('@/app/api/internal/email-retry/route');
    return POST(new Request('http://x/api/internal/email-retry', { method: 'POST', headers: header === undefined ? {} : { 'x-email-retry-secret': header } }));
  };

  it('is disabled (503) until EMAIL_RETRY_SECRET is configured', async () => {
    expect((await call('anything')).status).toBe(503);
    expect(retry.run).not.toHaveBeenCalled();
  });
  it('rejects a missing or wrong secret (401) without running anything', async () => {
    process.env.EMAIL_RETRY_SECRET = SECRET; resetServerEnvCache();
    expect((await call()).status).toBe(401);
    expect((await call('wrong')).status).toBe(401);
    expect((await call(SECRET.slice(0, -1))).status).toBe(401);
    expect(retry.run).not.toHaveBeenCalled();
  });
  it('runs with the right secret and returns counts only', async () => {
    process.env.EMAIL_RETRY_SECRET = SECRET; resetServerEnvCache();
    const response = await call(SECRET);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ accepted: 1, reconciled: 1 });
    expect(JSON.stringify(body)).not.toMatch(/@|secret|token/i);
  });
  it('uses a constant-time comparison', () => { expect(src('app/api/internal/email-retry/route.ts')).toContain('timingSafeEqual'); });
});

describe('shipping email', () => {
  const order = { trackUrl: 'https://one21eight.test/order-confirmation?order=o1&token=signed', id: 'o1', number: '1218-1001', status: 'shipped', total: 1078, contact: { name: 'Zak Khan', email: 'z@example.com' }, lines: [{ name: 'Grey T-Shirt', size: 'M', quantity: 1 }], paymentMethod: 'cod' };
  it('shows courier, tracking number and a clickable https tracking link, and keeps the signed order link', () => {
    const mail = orderEmail({ ...order, shipment: { carrier: 'Delhivery', trackingNumber: 'DL123456', trackingUrl: 'https://www.delhivery.com/track/package/DL123456' } }, 'status');
    expect(mail.html).toContain('Delhivery');
    expect(mail.html).toContain('DL123456');
    expect(mail.html).toContain('href="https://www.delhivery.com/track/package/DL123456"');
    expect(mail.html).toContain('TRACK YOUR PARCEL');
    expect(mail.html).toContain('href="https://one21eight.test/order-confirmation?order=o1&amp;token=signed"');
    expect(mail.text).toContain('Courier: Delhivery');
    expect(mail.text).toContain('Tracking: DL123456');
    expect(mail.text).toContain('Track your parcel: https://www.delhivery.com/track/package/DL123456');
    expect(mail.text).toContain('Track your order: https://one21eight.test/order-confirmation');
    expect(mail.html).toContain('View or track your order');
  });
  it('without a tracking link it still shows the courier and number, with no broken link', () => {
    const mail = orderEmail({ ...order, shipment: { carrier: 'Delhivery', trackingNumber: 'DL123456', trackingUrl: null } }, 'status');
    expect(mail.html).toContain('DL123456');
    expect(mail.html).not.toContain('TRACK YOUR PARCEL');
  });
  it('never renders an unsafe tracking link (http, javascript:), and escapes courier text', () => {
    for (const bad of ['http://courier.example/t/1', 'javascript:alert(1)']) {
      const mail = orderEmail({ ...order, shipment: { carrier: '<b>X</b>', trackingNumber: 'N1', trackingUrl: bad } }, 'status');
      expect(mail.html).not.toContain(bad);
      expect(mail.html).not.toContain('<b>X</b>');
    }
  });
  it('non-shipped emails are unchanged: no courier block when there is no shipment', () => {
    const mail = orderEmail({ ...order, status: 'processing', shipment: null }, 'status');
    expect(mail.html).not.toContain('Courier');
    expect(mail.html).toContain('We are preparing your order.');
  });
});

describe('tracking link validation (server + dialog)', () => {
  const parse = (trackingUrl: unknown) => updateOrderStatusSchema.safeParse({ status: 'shipped', trackingUrl });
  it('the API accepts an https link or none, and rejects anything else', () => {
    expect(parse('https://courier.example/t/1').success).toBe(true);
    expect(parse(undefined).success).toBe(true);
    expect(parse(null).success).toBe(true);
    for (const bad of ['http://courier.example/t/1', 'javascript:alert(1)', 'https://user:pw@courier.example/t', 'not a url', `https://courier.example/${'a'.repeat(500)}`]) expect(parse(bad).success, bad).toBe(false);
  });
  it('the Mark as shipped dialog has the optional field, validates before submitting and blocks a bad link', () => {
    const orders = src('components/admin/orders.tsx');
    expect(orders).toContain("name: 'trackingUrl'");
    expect(orders).toContain('parseTrackingUrl');
    expect(orders).toContain('trackingUrl: link.url');
    const dialog = src('components/admin/confirm-dialog.tsx');
    expect(dialog).toContain('field.validate');
    expect(dialog).toMatch(/if \(problem\) \{ setError\(problem\); return; \}/);
  });
});

describe('order confirmation page', () => {
  it('"Contact us about this order" drafts an email with the order number in subject and body', () => {
    const link = orderContactMailto('one21eight@gmail.com', '1218-1001')!;
    expect(link.startsWith('mailto:one21eight@gmail.com?')).toBe(true);
    const params = new URL(link.replace('mailto:', 'http://x/')).searchParams;
    expect(params.get('subject')).toBe('Order 1218-1001');
    expect(params.get('body')).toContain('order 1218-1001');
    expect(orderContactMailto('', '1218-1001')).toBeNull();
    expect(orderContactMailto(null, '1218-1001')).toBeNull();
  });
  it('the tracking timeline and shipping line are gone; Cancel and Return panels stay; contact action and email notice are present', () => {
    const actions = src('components/storefront/order-actions.tsx');
    expect(actions).not.toContain('order-timeline');
    expect(actions).not.toContain('<h2>Tracking</h2>');
    expect(actions).not.toContain('Courier updates are on the carrier');
    expect(actions).toContain('CONTACT US ABOUT THIS ORDER');
    expect(actions).toContain('orderContactMailto(contactEmail, order.number)');
    expect(actions).toContain('Automatic order status updates will arrive by email');
    expect(actions).toContain('CANCEL ORDER');
    expect(actions).toMatch(/Return|return/);
    expect(actions).toContain("This order was cancelled");
  });
  it('the page passes the configured store contact email and keeps its premium design blocks', () => {
    const page = src('components/storefront/pages/order-confirmation.tsx');
    expect(page).toContain('contactEmail={settings.contactEmail}');
    expect(page).toContain('confirmation-receipt');
    expect(page).toContain("We'll email you automatically each time your order status changes.");
  });
  it('the signed tracking link in emails and the customer account page are untouched', () => {
    expect(src('lib/backend/integrations.ts')).toContain('order.trackUrl');
    expect(src('components/storefront/pages/account-page.tsx')).not.toContain('OrderActions');
  });
});
