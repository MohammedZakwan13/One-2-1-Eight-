import 'server-only';
import { HttpError } from '@/lib/backend/core';

/**
 * Diagnostics for the MSG91 customer sign-in. Each line is `[otp] reason=<code> key=value ...` and carries ONLY a reason code, HTTP status, the provider's
 * response `type`, and booleans/counts. It never carries an OTP, access token, authkey, tokenAuth, phone number, request body or provider response body,
 * and none of it is returned to the browser.
 */
export type OtpReason =
  | 'validation_failed' | 'request_missing' | 'request_expired' | 'phone_mismatch' | 'attempts_exceeded'
  | 'provider_rejected' | 'provider_unavailable' | 'no_verified_mobile' | 'mobile_mismatch' | 'token_reused' | 'verified'
  | 'rate_limited_phone' | 'rate_limited_ip';

type SafeValue = string | number | boolean;

export function logOtp(reason: OtpReason, fields: Record<string, SafeValue> = {}): void {
  const detail = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ');
  const line = `[otp] reason=${reason}${detail ? ` ${detail}` : ''}`;
  console.warn(line);
}

/** Logs which schema fields failed (names only, e.g. "accessToken"), never their values, then rethrows. */
export function noteValidationFailure(error: unknown): never {
  if (error instanceof HttpError && error.code === 'validation_failed') logOtp('validation_failed', { fields: Object.keys(error.fieldErrors ?? {}).join(',') || 'unknown' });
  throw error;
}

export type OtpRequestRow = { id: string; phone: string; expires_at: string; attempts: number } | null;
const expired = () => new HttpError(422, 'otp_invalid', 'That code has expired. Request a new one.');

/** The request row created by /auth/otp/request must exist, belong to this phone, be unexpired and have attempts left. Each failure logs its own reason. */
export function checkOtpRequest(request: OtpRequestRow, phone: string, now = Date.now()): asserts request is NonNullable<OtpRequestRow> {
  if (!request) { logOtp('request_missing'); throw expired(); }
  if (request.phone !== phone) { logOtp('phone_mismatch', { where: 'request_row' }); throw expired(); }
  if (Date.parse(request.expires_at) < now) { logOtp('request_expired'); throw expired(); }
  if (request.attempts >= 5) { logOtp('attempts_exceeded'); throw expired(); }
}

/** The mobile MSG91 verified must be the number this request was made for. */
export function requireSameMobile(verified: string, phone: string, equal: (a: string, b: string) => boolean): void {
  if (!equal(verified, phone)) { logOtp('mobile_mismatch'); throw new HttpError(422, 'otp_invalid', 'That code could not be verified. Request a new one.'); }
}

/** Notes a 429 from one of the two send gates, then rethrows it unchanged. */
export function noteRateLimit(error: unknown, reason: 'rate_limited_phone' | 'rate_limited_ip' | 'token_reused'): never {
  if (error instanceof HttpError && error.status === 429) logOtp(reason);
  throw error;
}
