import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SMS_CHANNEL, WidgetError, pickAccessToken, pickReqId, retryChannel, retryCode, sendCode } from '@/lib/msg91-widget';

const norm = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const keys = { widgetId: 'w', tokenAuth: 't' };

/** A stand-in for the SDK, with the real SDK's rule for a "Custom" widget: retryOtp() without a channel fails before sending anything. */
function installSdk(options: { retry?: 'ok' | 'fail' | 'silent'; send?: 'ok' | 'fail' | 'silent'; processes?: unknown } = {}) {
  const calls: unknown[][] = [];
  const w: Record<string, unknown> = {
    initSendOTP: vi.fn(),
    getWidgetData: () => ({ captchaValidations: 0, processes: options.processes ?? [{ processVia: { value: '2' }, channel: { value: '11' } }, { processVia: { value: '5' }, channel: { value: '11' } }] }),
    sendOtp: (id: string, ok: (d: unknown) => void, fail: (e: unknown) => void) => { calls.push(['send', id]); if (options.send === 'fail') fail({ message: 'no' }); else if (options.send !== 'silent') ok({ type: 'success', message: 'REQ-9' }); },
    retryOtp: (channel: string | null, ok: (d: unknown) => void, fail: (e: unknown) => void, reqId: string) => {
      calls.push(['retry', channel, reqId]);
      if (!channel) { fail({ message: 'Channel not provided in retryOtp() method.' }); return; }
      if (options.retry === 'fail') fail({ message: 'provider says no' }); else if (options.retry !== 'silent') ok({ type: 'success', message: 'sent' });
    },
    verifyOtp: vi.fn(),
  };
  vi.stubGlobal('window', w);
  vi.stubGlobal('document', { head: { appendChild: vi.fn() }, createElement: vi.fn() });
  return { calls };
}

describe('resend (retryOtp) through the MSG91 widget', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('names the SMS channel, which the SDK requires for this Custom widget (a null channel was the bug: it failed before anything was sent)', async () => {
    const { calls } = installSdk();
    const { retryCode: retry } = await import('@/lib/msg91-widget');
    await retry(keys, 'REQ-9', 'captcha');
    expect(calls).toEqual([['retry', '11', 'REQ-9']]);
  });
  it('uses the widget\'s own retry channel when it can be read, and SMS when it cannot', () => {
    expect(retryChannel({ processes: [{ processVia: { value: '2' }, channel: { value: '11' } }, { processVia: { value: '5' }, channel: { value: '12' } }] })).toBe('12');
    expect(retryChannel({ processes: [{ processVia: { value: '2' }, channel: { value: '11' } }] })).toBe('11');
    for (const data of [null, undefined, {}, { processes: [] }, { processes: [{ channel: { value: 'sms' } }] }]) expect(retryChannel(data as never)).toBe(SMS_CHANNEL);
    expect(SMS_CHANNEL).toBe('11');
  });
  it('a provider refusal becomes a clear, shopper-facing WidgetError (not an unknown error)', async () => {
    installSdk({ retry: 'fail' });
    const { retryCode: retry, WidgetError: Err } = await import('@/lib/msg91-widget');
    const error = await retry(keys, 'REQ-9', 'captcha').catch(e => e);
    expect(error).toBeInstanceOf(Err); expect(error.message).toBe('We could not resend the code. Please try again.');
  });
  it('a silent SDK ends after 20 s with an honest message (the resend does not ask for a security check; the first send does)', async () => {
    vi.useFakeTimers();
    installSdk({ retry: 'silent', send: 'silent' });
    const mod = await import('@/lib/msg91-widget');
    const retry = mod.retryCode(keys, 'REQ-9', 'captcha').catch(e => e); await vi.advanceTimersByTimeAsync(20_001);
    expect((await retry).message).toBe('The verification service did not answer. Please try again.');
    const send = mod.sendCode(keys, '9876543210', 'captcha').catch(e => e); await vi.advanceTimersByTimeAsync(20_001);
    expect((await send).message).toBe('Please complete the security check, then try again.');
  });
  it('the first send is unchanged: 91 + the 10 digits, resolving with the provider request id', async () => {
    const { calls } = installSdk();
    const mod = await import('@/lib/msg91-widget');
    expect(await mod.sendCode(keys, '9876543210', 'captcha')).toBe('REQ-9'); expect(calls).toEqual([['send', '919876543210']]);
  });
  it('request id and access token parsing is unchanged', () => {
    expect(pickReqId({ message: 'abc' })).toBe('abc'); expect(() => pickReqId({ message: ' ' })).toThrow(WidgetError);
    expect(pickAccessToken({ message: 'a.b.c' })).toBe('a.b.c'); expect(() => pickAccessToken({ message: 'OTP verified' })).toThrow(WidgetError);
    expect(typeof retryCode).toBe('function'); expect(typeof sendCode).toBe('function');
  });
});

describe('login page wiring (source guards)', () => {
  const page = norm('components/storefront/pages/login-page.tsx');
  it('widget errors are shown as written (they were hidden behind "Something went wrong"); our API errors too; anything unknown stays generic', () => {
    expect(page).toContain('error instanceof WidgetError ? error.message : errorMessage(error)');
    expect(page.match(/setAuthError\(otpError\(error\)\)/g)!.length).toBe(2); // request/resend and verify
  });
  it('duplicate clicks are ignored while a request runs, and the button is disabled', () => {
    expect(page).toContain('if (inFlight.current) return;'); expect(page).toContain('disabled={busy || cooldown > 0}');
  });
  it('the cooldown starts only after a code was really sent, counts down each second, and is cleared when the number changes', () => {
    const request = page.slice(page.indexOf('const requestCode'), page.indexOf('const sendOtp'));
    expect(request.indexOf('setCooldown(result.resendAfterSeconds)')).toBeGreaterThan(request.indexOf('await retryCode'));
    expect(request.indexOf('setCooldown(result.resendAfterSeconds)')).toBeLessThan(request.indexOf('catch (error)')); // never reached on a failure
    expect(page).toContain('RESEND CODE IN ${cooldown}S'); expect(page).toContain('setCooldown(0)');
  });
  it('success messages appear only after success', () => {
    const request = page.slice(page.indexOf('const requestCode'), page.indexOf('const sendOtp'));
    expect(request.indexOf("notify(resend ? 'Verification code resent.'")).toBeGreaterThan(request.indexOf('await retryCode'));
    expect(request.indexOf("notify(resend ? 'Verification code resent.'")).toBeLessThan(request.indexOf('catch (error)'));
  });
  it('the server gate, the OTP verification and the sign-in flow are untouched', () => {
    expect(page).toContain('api.auth.requestOtp(phone)'); expect(page).toContain('api.auth.verifyOtp({ requestId, phone, accessToken })');
    expect(page).toContain('verifyCode(widget.current, otp.join(\'\'), widget.current.reqId, CAPTCHA_ID)');
  });
});
