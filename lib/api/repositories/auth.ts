import type { Caller } from '@/lib/api/http';
import { customerSchema, otpConfigSchema, otpRequestResponseSchema, savedAddressListSchema, savedAddressSchema, sessionSchema, type SavedAddressInput } from '@/lib/api/schemas';

export const authRepository = (call: Caller) => ({
  otpConfig: () => call('/auth/otp/config', otpConfigSchema),
  requestOtp: (phone: string) => call('/auth/otp/request', otpRequestResponseSchema, { method: 'POST', body: { phone } }),
  verifyOtp: (input: { requestId: string; phone: string; accessToken: string }) => call('/auth/otp/verify', sessionSchema, { method: 'POST', body: input }),
  logout: () => call('/auth/logout', null, { method: 'POST' }),
  /** Rejects with a 401 ApiError when nobody is signed in. */
  me: (signal?: AbortSignal, options: { forwardCookies?: boolean } = {}) => call('/me', customerSchema, { signal, retries: 0, forwardCookies: options.forwardCookies, revalidate: false }),
  addresses: {
    list: () => call('/me/addresses', savedAddressListSchema, { retries: 0 }),
    create: (address: SavedAddressInput) => call('/me/addresses', savedAddressSchema, { method: 'POST', body: address }),
    remove: (id: string) => call(`/me/addresses/${encodeURIComponent(id)}`, null, { method: 'DELETE' }),
  },
});
