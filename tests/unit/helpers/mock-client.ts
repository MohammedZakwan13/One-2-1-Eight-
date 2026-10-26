import { resetServerEnvCache } from '@/lib/env';
import { handleMockRequest } from '@/mocks/router';
import { resetState } from '@/mocks/store';

export const TEST_ENV = {
  APP_ENV: 'test',
  API_MODE: 'mock',
  MOCK_ADMIN_EMAIL: 'unit-admin@localhost.invalid',
  MOCK_ADMIN_PASSWORD: 'unit-test-password-1',
  MOCK_OTP_CODE: '123456',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
} as const;

/** Configures the process env for mock mode and resets all in-memory state. Call in `beforeEach`. */
export function useMockEnvironment() {
  for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
  resetServerEnvCache();
  resetState();
}

type ClientResponse = { status: number; body: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Minimal browser-like client (cookie jar + CSRF double-submit) on top of the mock router. */
export class MockClient {
  readonly jar = new Map<string, string>();

  private cookieHeader() {
    return [...this.jar.entries()].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, options: { csrf?: boolean } = {}): Promise<ClientResponse> {
    const mutating = method !== 'GET';
    if (mutating && options.csrf !== false && !headers['X-CSRF-Token'] && path !== '/__mock/reset') {
      const token = await this.request('GET', '/csrf-token');
      headers = { ...headers, 'X-CSRF-Token': token.body.token };
    }
    const response = await handleMockRequest(new Request(`http://localhost:3000/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: this.cookieHeader(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = decodeURIComponent(pair.slice(index + 1));
      const maxAge = attrs.map(item => item.trim()).find(item => item.toLowerCase().startsWith('max-age='));
      if (maxAge === 'Max-Age=0' || value === '') this.jar.delete(name); else this.jar.set(name, value);
    }
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* csv etc. */ }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown, headers?: Record<string, string>) => this.request('POST', path, body, headers);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
  patch = (path: string, body?: unknown) => this.request('PATCH', path, body);
  delete = (path: string) => this.request('DELETE', path);

  async signInAdmin() {
    return this.post('/admin/auth/login', { email: TEST_ENV.MOCK_ADMIN_EMAIL, password: TEST_ENV.MOCK_ADMIN_PASSWORD });
  }
  async signInCustomer(phone = '9876543210') {
    const requested = await this.post('/auth/otp/request', { phone });
    return this.post('/auth/otp/verify', { requestId: requested.body.requestId, phone, otp: TEST_ENV.MOCK_OTP_CODE });
  }
}
