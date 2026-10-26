import type { Caller } from '@/lib/api/http';
import { customerSchema, otpRequestResponseSchema, sessionSchema } from '@/lib/api/schemas';

export const authRepository = (call: Caller) => ({
  requestOtp: (phone: string) => call('/auth/otp/request', otpRequestResponseSchema, { method: 'POST', body: { phone } }),
  verifyOtp: (input: { requestId: string; phone: string; otp: string }) => call('/auth/otp/verify', sessionSchema, { method: 'POST', body: input }),
  logout: () => call('/auth/logout', null, { method: 'POST' }),
  /** Rejects with a 401 ApiError when nobody is signed in. */
  me: (signal?: AbortSignal) => call('/me', customerSchema, { signal, retries: 0 }),
});
