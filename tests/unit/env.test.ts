import { describe, expect, it } from 'vitest';
import { EnvError, parseServerEnv } from '@/lib/env';

const live = { API_BASE_URL: 'https://api.shop.in/v1', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in' };

describe('parseServerEnv', () => {
  it('treats a production build as production by default and requires real configuration', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production' })).toThrow(EnvError);
    const env = parseServerEnv({ NODE_ENV: 'production', ...live });
    expect(env.appEnv).toBe('production');
    expect(env.isProduction).toBe(true);
    expect(env.mockEnabled).toBe(false);
    expect(env.apiBaseUrl).toBe('https://api.shop.in/v1');
  });

  it('never allows mock mode outside development/test', () => {
    for (const appEnv of ['production', 'staging']) {
      expect(() => parseServerEnv({ ...live, APP_ENV: appEnv, API_MODE: 'mock' })).toThrow(/only permitted/);
    }
    // NODE_ENV=production without APP_ENV defaults to production → mock refused too
    expect(() => parseServerEnv({ NODE_ENV: 'production', ...live, API_MODE: 'mock' })).toThrow(/only permitted/);
  });

  it('allows mock mode in development and test, with optional env-provided mock credentials', () => {
    const env = parseServerEnv({ APP_ENV: 'test', API_MODE: 'mock', MOCK_ADMIN_EMAIL: 'a@localhost.invalid', MOCK_ADMIN_PASSWORD: 'long-enough-1' });
    expect(env.mockEnabled).toBe(true);
    expect(env.mockAdmin).toEqual({ email: 'a@localhost.invalid', password: 'long-enough-1' });
    expect(env.siteUrl).toBe('http://localhost:3000');
  });

  it('has no built-in admin credentials', () => {
    expect(parseServerEnv({ APP_ENV: 'development', API_MODE: 'mock' }).mockAdmin).toBeNull();
  });

  it('ignores mock credentials entirely when mock mode is off', () => {
    const env = parseServerEnv({ APP_ENV: 'production', ...live, MOCK_ADMIN_EMAIL: 'a@b.co', MOCK_ADMIN_PASSWORD: 'long-enough-1', MOCK_OTP_CODE: '123456' });
    expect(env.mockAdmin).toBeNull();
    expect(env.mockOtpCode).toBeNull();
  });

  it('requires an API base URL in live mode and https in production', () => {
    expect(() => parseServerEnv({ APP_ENV: 'development' })).toThrow(/API_BASE_URL is required/);
    expect(() => parseServerEnv({ APP_ENV: 'production', API_BASE_URL: 'http://api.shop.in', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in' })).toThrow(/https/);
    expect(parseServerEnv({ APP_ENV: 'development', API_BASE_URL: 'http://localhost:4000/v1' }).apiBaseUrl).toBe('http://localhost:4000/v1');
  });

  it('rejects placeholder or non-https site URLs in production', () => {
    for (const siteUrl of ['https://one2oneight.example', 'https://your-domain.com', 'https://shop.invalid', 'http://www.shop.in', 'https://localhost']) {
      expect(() => parseServerEnv({ APP_ENV: 'production', API_BASE_URL: live.API_BASE_URL, NEXT_PUBLIC_SITE_URL: siteUrl })).toThrow(EnvError);
    }
  });

  it('requires a site URL for staging and production but not local development', () => {
    expect(() => parseServerEnv({ APP_ENV: 'staging', API_BASE_URL: live.API_BASE_URL })).toThrow(/NEXT_PUBLIC_SITE_URL/);
    expect(parseServerEnv({ APP_ENV: 'development', API_MODE: 'mock' }).siteUrl).toBe('http://localhost:3000');
  });

  it('normalises trailing slashes and rejects malformed values', () => {
    const env = parseServerEnv({ APP_ENV: 'production', API_BASE_URL: 'https://api.shop.in/v1/', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in/' });
    expect(env.apiBaseUrl).toBe('https://api.shop.in/v1');
    expect(env.siteUrl).toBe('https://www.shop.in');
    expect(() => parseServerEnv({ APP_ENV: 'development', API_MODE: 'mock', API_TIMEOUT_MS: '10' })).toThrow(EnvError);
    expect(() => parseServerEnv({ APP_ENV: 'development', API_MODE: 'mock', ADMIN_SESSION_COOKIE: 'bad name;' })).toThrow(EnvError);
  });
});
