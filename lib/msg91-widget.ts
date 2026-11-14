'use client';

/**
 * Browser wrapper for the MSG91 OTP Widget (Web SDK, custom UI): initSendOTP({ exposeMethods: true, captchaRenderId }) exposes window.sendOtp / retryOtp / verifyOtp.
 * Verified against the SDK file MSG91 serves (https://verify.msg91.com/otp-provider.js):
 * - sendOtp(identifier, ok, fail): `ok` gets the whole response; the SDK itself stores `response.message` as the reqId, so we do the same. Identifier = "91" + 10 digits.
 * - retryOtp(channel, ok, fail, reqId) and verifyOtp(otp, ok, fail, reqId) send that reqId back to MSG91. For a "Custom" widget (widgetType 2, the type this site's
 *   widget has) retryOtp REQUIRES a channel: with null it calls `fail` with "Channel not provided in retryOtp() method." and sends nothing. SMS is channel "11".
 * - verifyOtp's `ok` gets the response; its access token is in `message` (or `access-token`). That token is NOT proof of login: our server verifies it with MSG91.
 * - CAPTCHA (widget setting): with a `captchaRenderId` the SDK renders the challenge in our element, and sendOtp silently does nothing (no callback) until
 *   isCaptchaVerified() is true, so callers must check captchaPassed() first. hCaptcha tokens are single use; the SDK resets the challenge after a failed send.
 * widgetId / tokenAuth come from the backend at runtime; the server-side Authkey never reaches the browser.
 */

type Reply = { type?: string; message?: string; 'access-token'?: string };
type Callback = (data: Reply) => void;
type Failure = (error: { code?: string | number; message?: string }) => void;
type WidgetWindow = Window & {
  initSendOTP?: (config: Record<string, unknown>) => void;
  sendOtp?: (identifier: string, success: Callback, failure: Failure) => void;
  retryOtp?: (channel: string | null, success: Callback, failure: Failure, reqId?: string) => void;
  verifyOtp?: (otp: string | number, success: Callback, failure: Failure, reqId?: string) => void;
  getWidgetData?: () => { captchaValidations?: unknown; processes?: { processVia?: { value?: string }; channel?: { value?: string } }[] } | null;
  isCaptchaVerified?: () => boolean;
};

export type WidgetKeys = { widgetId: string; tokenAuth: string };
const SCRIPT_URL = 'https://verify.msg91.com/otp-provider.js';
const REQUEST_TIMEOUT_MS = 20_000;
export class WidgetError extends Error {}

let ready: Promise<void> | null = null;
let readyFor = '';

function loadScript(): Promise<void> {
  if ((window as WidgetWindow).initSendOTP) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new WidgetError('We could not load the verification service. Please try again.')); };
    document.head.appendChild(script);
  });
}

/** Loads and initialises the widget once. `captchaRenderId` is the id of an element that is already in the page; the SDK draws the CAPTCHA there. */
export async function prepareWidget(keys: WidgetKeys, captchaRenderId: string): Promise<void> {
  const key = `${keys.widgetId}:${keys.tokenAuth}:${captchaRenderId}`;
  if (!ready || readyFor !== key) {
    readyFor = key;
    ready = (async () => {
      await loadScript();
      const w = window as WidgetWindow;
      w.initSendOTP?.({ widgetId: keys.widgetId, tokenAuth: keys.tokenAuth, exposeMethods: true, captchaRenderId, success: () => {}, failure: () => {} });
      for (let waited = 0; !(w.sendOtp && w.verifyOtp && w.retryOtp); waited += 50) {
        if (waited >= 10_000) throw new WidgetError('The verification service did not start. Please try again.');
        await new Promise(r => setTimeout(r, 50));
      }
    })();
    ready.catch(() => { ready = null; });
  }
  await ready;
}

/** True when the widget has CAPTCHA switched on and the visitor has not solved it yet (sending would silently do nothing). */
export function captchaPending(): boolean {
  const w = window as WidgetWindow;
  return Boolean(w.getWidgetData?.()?.captchaValidations) && !w.isCaptchaVerified?.();
}

/** The reqId is the send response's `message`; refuse anything that is not a non-empty string. */
export function pickReqId(data: Reply | null | undefined): string {
  if (typeof data?.message !== 'string' || !data.message.trim()) throw new WidgetError('The verification service gave an unexpected answer. Please try again.');
  return data.message;
}

/** The access token is a JWT (three dot-separated parts) in `access-token` or `message`; a plain status text such as "OTP verified successfully" is not a token. */
export function pickAccessToken(data: Reply | null | undefined): string {
  for (const candidate of [data?.['access-token'], data?.message]) {
    if (typeof candidate === 'string' && candidate.split('.').length === 3) return candidate;
  }
  throw new WidgetError('The verification service gave an unexpected answer. Please try again.');
}

const NO_ANSWER = 'The verification service did not answer. Please try again.';
const run = <T>(start: (ok: Callback, fail: Failure) => void, parse: (data: Reply) => T, failText: string, silentText: string = NO_ANSWER) =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
    // The SDK returns without any callback in some states (e.g. CAPTCHA not solved), so never wait forever.
    const timer = setTimeout(() => finish(() => reject(new WidgetError(silentText))), REQUEST_TIMEOUT_MS);
    try { start(data => finish(() => { try { resolve(parse(data)); } catch (error) { reject(error); } }), () => finish(() => reject(new WidgetError(failText)))); }
    catch { finish(() => reject(new WidgetError(failText))); }
  });

/** Sends the first code. `mobile` is the 10-digit number. Resolves with the provider reqId. */
export async function sendCode(keys: WidgetKeys, mobile: string, captchaRenderId: string): Promise<string> {
  await prepareWidget(keys, captchaRenderId);
  const w = window as WidgetWindow;
  return run((ok, fail) => w.sendOtp!(`91${mobile}`, ok, fail), pickReqId, 'We could not send the code. Please try again.', 'Please complete the security check, then try again.');
}

/** SMS in MSG91's channel list; the fallback when the widget's own retry process cannot be read. */
export const SMS_CHANNEL = '11';

/** The channel MSG91 expects for a resend: the widget's own RETRY process (processVia 5) when it can be read, otherwise SMS. */
export function retryChannel(data: ReturnType<NonNullable<WidgetWindow['getWidgetData']>> | undefined): string {
  const processes = data?.processes ?? [];
  const process = processes.find(item => item?.processVia?.value === '5') ?? processes[0];
  const channel = process?.channel?.value;
  return typeof channel === 'string' && /^\d+$/.test(channel) ? channel : SMS_CHANNEL;
}

/** Resends through the same provider request over SMS. The SDK needs the channel named explicitly for this widget (see the notes at the top). */
export async function retryCode(keys: WidgetKeys, reqId: string, captchaRenderId: string): Promise<void> {
  await prepareWidget(keys, captchaRenderId);
  const w = window as WidgetWindow;
  const channel = retryChannel(w.getWidgetData?.());
  await run((ok, fail) => w.retryOtp!(channel, ok, fail, reqId), () => undefined, 'We could not resend the code. Please try again.');
}

/** Checks the code with MSG91 and resolves with the access token, which still must be verified by our server. */
export async function verifyCode(keys: WidgetKeys, code: string, reqId: string, captchaRenderId: string): Promise<string> {
  await prepareWidget(keys, captchaRenderId);
  const w = window as WidgetWindow;
  return run((ok, fail) => w.verifyOtp!(code, ok, fail, reqId), pickAccessToken, 'That code is not correct or has expired.');
}
