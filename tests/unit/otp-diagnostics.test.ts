import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, formatWait, retryAfterSeconds, safeEqual } from '@/lib/backend/core';
import { resetServerEnvCache } from '@/lib/env';
import { verifyOtpAccessToken } from '@/lib/backend/integrations';
import { checkOtpRequest, logOtp, noteRateLimit, noteValidationFailure, requireSameMobile } from '@/lib/backend/otp';

const AUTH = 'authkey-SECRET-123';
const TOKEN = 'header.payload.access-token-SECRET-456';
const PHONE = '9876543210';
const future = () => new Date(Date.now() + 60_000).toISOString();
const row = (over: Record<string, unknown> = {}) => ({ id: 'r1', phone: PHONE, expires_at: future(), attempts: 0, ...over }) as never;

const saved = { ...process.env };
let lines: string[] = [];
beforeEach(() => {
  lines = [];
  Object.assign(process.env, { APP_ENV: 'development', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a' });
  resetServerEnvCache();
  for (const method of ['warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation((...args) => { lines.push(args.map(String).join(' ')); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.env = { ...saved }; resetServerEnvCache(); });

const catchError = (fn: () => unknown) => { try { fn(); } catch (error) { return error as HttpError; } throw new Error('expected a throw'); };

describe('verification diagnostics: request-row branches', () => {
  it('accepts a live row for the same phone, logging nothing', () => {
    expect(() => checkOtpRequest(row(), PHONE)).not.toThrow();
    expect(lines).toEqual([]);
  });
  it.each([
    ['request_missing', null, PHONE],
    ['phone_mismatch', row({ phone: '9123456780' }), PHONE],
    ['request_expired', row({ expires_at: new Date(Date.now() - 1000).toISOString() }), PHONE],
    ['attempts_exceeded', row({ attempts: 5 }), PHONE],
  ])('%s: logs its reason and answers the same generic 422', (reason, request, phone) => {
    const error = catchError(() => checkOtpRequest(request as never, phone));
    expect(error).toMatchObject({ status: 422, code: 'otp_invalid', message: 'That code has expired. Request a new one.' });
    expect(lines).toEqual([expect.stringContaining(`[otp] reason=${reason}`)]);
    expect(lines.join('\n')).not.toContain(PHONE);
  });
});

describe('verification diagnostics: validation, mobile match, rate limits', () => {
  it('logs only the NAMES of invalid fields, then rethrows the original error', () => {
    const original = new HttpError(422, 'validation_failed', 'Some details need your attention.', { accessToken: ['Too small'], phone: ['bad'] });
    expect(catchError(() => noteValidationFailure(original))).toBe(original);
    expect(lines).toEqual(['[otp] reason=validation_failed fields=accessToken,phone']);
    expect(catchError(() => noteValidationFailure(new HttpError(500, 'server_error', 'x')))).toMatchObject({ status: 500 });
    expect(lines).toHaveLength(1);
  });
  it('accepts a verified mobile equal to the requested one and rejects a different one with a generic 422', () => {
    expect(() => requireSameMobile(PHONE, PHONE, safeEqual)).not.toThrow();
    const error = catchError(() => requireSameMobile('9123456780', PHONE, safeEqual));
    expect(error).toMatchObject({ status: 422, code: 'otp_invalid', message: 'That code could not be verified. Request a new one.' });
    expect(lines).toEqual(['[otp] reason=mobile_mismatch']);
    expect(lines.join('\n')).not.toMatch(/9123456780|9876543210/);
  });
  it('labels a 429 from the phone gate, the IP gate and the used-token check, and passes other errors through silently', () => {
    for (const reason of ['rate_limited_phone', 'rate_limited_ip', 'token_reused'] as const) {
      const limited = new HttpError(429, 'rate_limited', 'Too many.');
      expect(catchError(() => noteRateLimit(limited, reason))).toBe(limited);
    }
    expect(lines).toEqual(['[otp] reason=rate_limited_phone', '[otp] reason=rate_limited_ip', '[otp] reason=token_reused']);
    lines.length = 0;
    expect(catchError(() => noteRateLimit(new HttpError(500, 'server_error', 'x'), 'token_reused'))).toMatchObject({ status: 500 });
    expect(lines).toEqual([]);
  });
  it('reports the remaining wait from the oldest counted event, as a duration only', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    // 3 events in a 600s window; the oldest was 420s ago, so a slot frees in 180s.
    const newestFirst = [new Date(now - 10_000).toISOString(), new Date(now - 200_000).toISOString(), new Date(now - 420_000).toISOString()];
    expect(retryAfterSeconds(newestFirst, 600, now)).toBe(180);
    expect(retryAfterSeconds([new Date(now - 700_000).toISOString()], 600, now)).toBe(1);
    expect(retryAfterSeconds([], 600, now)).toBe(600);
    expect(formatWait(45)).toBe('45 seconds');
    expect(formatWait(1)).toBe('1 second');
    expect(formatWait(180)).toBe('3 minutes');
    expect(formatWait(600)).toBe('10 minutes');
  });
  it('logs the success line without any identifying value', () => {
    logOtp('verified', { newCustomer: false });
    expect(lines).toEqual(['[otp] reason=verified newCustomer=false']);
  });
});

describe('verification diagnostics: MSG91 access-token branches (mocked fetch)', () => {
  const configure = () => { Object.assign(process.env, { MSG91_AUTH_KEY: AUTH, MSG91_WIDGET_ID: 'wid_1', MSG91_WIDGET_TOKEN_AUTH: 'tok_1' }); resetServerEnvCache(); };
  const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  const assertSafe = () => {
    const text = lines.join('\n');
    for (const secret of [AUTH, 'SECRET-456', 'tok_1', 'wid_1', PHONE, 'bad-detail']) expect(text).not.toContain(secret);
  };

  it('rejected token (error body or HTTP error): logs reason, status and type only', async () => {
    configure();
    vi.stubGlobal('fetch', reply({ type: 'error', message: `bad-detail ${TOKEN} ${AUTH}` }, 401));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 422, code: 'otp_invalid' });
    vi.stubGlobal('fetch', reply({ message: 'bad-detail' }));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 422 });
    expect(lines).toEqual(['[otp] reason=provider_rejected status=401 type=error', '[otp] reason=provider_rejected status=200 type=none']);
    assertSafe();
  });
  it('provider outage: network error, 5xx and non-JSON are logged as provider_unavailable and answered with a generic 502', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`fetch failed ${AUTH}`); }));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 502, message: 'We could not verify the code. Please try again.' });
    vi.stubGlobal('fetch', reply({ type: 'success' }, 503));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 502 });
    vi.stubGlobal('fetch', reply('<html>bad-detail</html>'));
    await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 502 });
    expect(lines).toEqual([
      '[otp] reason=provider_unavailable stage=network error=TypeError',
      '[otp] reason=provider_unavailable stage=response status=503 jsonBody=true',
      '[otp] reason=provider_unavailable stage=response status=200 jsonBody=false',
    ]);
    assertSafe();
  });
  it('success without an identifiable mobile stays rejected and logs only a category and a key count', async () => {
    configure();
    const cases: Array<[unknown, string]> = [['bad-detail status text', 'text'], ['12345', 'invalid_number'], [undefined, 'missing'], [12, 'non_string']];
    for (const [message, kind] of cases) {
      lines.length = 0;
      vi.stubGlobal('fetch', reply({ type: 'success', message }));
      await expect(verifyOtpAccessToken(TOKEN)).rejects.toMatchObject({ status: 422, code: 'otp_invalid' });
      expect(lines).toEqual([`[otp] reason=no_verified_mobile status=200 type=success messageKind=${kind} topLevelKeys=${message === undefined ? 1 : 2}`]);
      assertSafe();
    }
  });
  it('the live response shape { type: "success", message: "<mobile>" } returns the normalised mobile and logs nothing', async () => {
    configure();
    vi.stubGlobal('fetch', reply({ type: 'success', message: `91${PHONE}` }));
    await expect(verifyOtpAccessToken(TOKEN)).resolves.toBe(PHONE);
    expect(lines).toEqual([]);
  });
});
