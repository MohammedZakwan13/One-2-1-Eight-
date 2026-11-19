import { describe, expect, it } from 'vitest';
import { EnvError, parseServerEnv } from '@/lib/env';

const supabase = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key' };
const proxy = { TRUSTED_PROXY: 'cloudflare', TRUSTED_PROXY_SECRET: 'origin-secret-0123456789-abcdef' };
const prod = { ...supabase, ...proxy, NEXT_PUBLIC_SITE_URL: 'https://www.shop.in' };

describe('email provider selection', () => {
  it('rejects the Mailpit provider in production and never falls back to it', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production', ...prod, EMAIL_PROVIDER: 'mailpit' })).toThrow(/local testing only/);
    expect(() => parseServerEnv({ APP_ENV: 'production', ...prod, EMAIL_PROVIDER: 'mailpit' })).toThrow(EnvError);
  });
  it('defaults to Resend (unconfigured = no provider, not Mailpit) and enables Mailpit only when asked locally', () => {
    const plain = parseServerEnv({ APP_ENV: 'development', ...supabase });
    expect(plain.mailpit).toBeNull();
    expect(plain.resend).toBeNull();
    const local = parseServerEnv({ APP_ENV: 'development', ...supabase, EMAIL_PROVIDER: 'mailpit' });
    expect(local.mailpit).toMatchObject({ host: 'localhost', port: 1025 });
    expect(local.resend).toBeNull();
    expect(parseServerEnv({ APP_ENV: 'development', ...supabase, EMAIL_PROVIDER: 'mailpit', SMTP_HOST: 'mailpit' }).mailpit?.host).toBe('mailpit');
  });
  it('keeps Resend usable with only configuration once the keys exist', () => {
    const env = parseServerEnv({ APP_ENV: 'development', ...supabase, RESEND_API_KEY: 're_x', EMAIL_FROM: 'Shop <orders@shop.in>' });
    expect(env.resend).toMatchObject({ from: 'Shop <orders@shop.in>' });
    expect(env.mailpit).toBeNull();
  });
});

describe('parseServerEnv', () => {
  it('defaults to the built-in Supabase backend and treats a production build as production', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production' })).toThrow(EnvError);
    const env = parseServerEnv({ NODE_ENV: 'production', ...prod });
    expect(env.appEnv).toBe('production');
    expect(env.isProduction).toBe(true);
    expect(env.apiMode).toBe('supabase');
    expect(env.supabase?.url).toBe('https://abc.supabase.co');
  });

  it('names exactly which Supabase variables are missing', () => {
    expect(() => parseServerEnv({ APP_ENV: 'development', SUPABASE_URL: supabase.SUPABASE_URL })).toThrow(/SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY/);
  });

  it('tolerates missing secrets only during `next build`', () => {
    const env = parseServerEnv({ APP_ENV: 'development', NEXT_PHASE: 'phase-production-build' });
    expect(env.supabase).toBeNull();
  });

  it('rejects the removed mock mode', () => {
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, API_MODE: 'mock' })).toThrow(EnvError);
  });

  it('requires an API base URL in live mode and https in production', () => {
    expect(() => parseServerEnv({ APP_ENV: 'development', API_MODE: 'live' })).toThrow(/API_BASE_URL is required/);
    expect(() => parseServerEnv({ APP_ENV: 'production', API_MODE: 'live', API_BASE_URL: 'http://api.shop.in', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in' })).toThrow(/https/);
    expect(parseServerEnv({ APP_ENV: 'development', API_MODE: 'live', API_BASE_URL: 'http://localhost:4000/v1' }).apiBaseUrl).toBe('http://localhost:4000/v1');
  });

  it('requires https for Supabase in production', () => {
    expect(() => parseServerEnv({ APP_ENV: 'production', ...prod, SUPABASE_URL: 'http://abc.supabase.co' })).toThrow(/https/);
  });

  it('rejects placeholder or non-https site URLs in production', () => {
    for (const siteUrl of ['https://one2oneight.example', 'https://your-domain.com', 'https://shop.invalid', 'http://www.shop.in', 'https://localhost']) {
      expect(() => parseServerEnv({ APP_ENV: 'production', ...supabase, NEXT_PUBLIC_SITE_URL: siteUrl })).toThrow(EnvError);
    }
  });

  it('requires a site URL for staging and production but not local development', () => {
    expect(() => parseServerEnv({ APP_ENV: 'staging', ...supabase })).toThrow(/NEXT_PUBLIC_SITE_URL/);
    expect(parseServerEnv({ APP_ENV: 'development', ...supabase }).siteUrl).toBe('http://localhost:3000');
  });

  it('requires paired provider credentials and exposes them only when complete', () => {
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, RAZORPAY_KEY_ID: 'rzp_test_x' })).toThrow(/RAZORPAY/);
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, RESEND_API_KEY: 're_x' })).toThrow(/EMAIL_FROM/);
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, MSG91_AUTH_KEY: 'k' })).toThrow(/MSG91/);
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, MSG91_AUTH_KEY: 'k', MSG91_WIDGET_ID: 'w' })).toThrow(/MSG91/);
    const bare = parseServerEnv({ APP_ENV: 'development', ...supabase });
    expect(bare.razorpay).toBeNull();
    expect(bare.resend).toBeNull();
    expect(bare.msg91).toBeNull();
    expect(parseServerEnv({ APP_ENV: 'development', ...supabase, MSG91_AUTH_KEY: 'k', MSG91_WIDGET_ID: 'w1', MSG91_WIDGET_TOKEN_AUTH: 't1' }).msg91).toEqual({ authKey: 'k', widgetId: 'w1', tokenAuth: 't1' });
    const full = parseServerEnv({ APP_ENV: 'development', ...supabase, RESEND_API_KEY: 're_x', EMAIL_FROM: 'Shop <orders@shop.in>', INTERNAL_NOTIFICATION_EMAIL: 'team@shop.in' });
    expect(full.resend).toEqual({ apiKey: 're_x', from: 'Shop <orders@shop.in>', internalEmail: 'team@shop.in', webhookSecret: null });
  });

  it('serves API docs outside production by default, and only on request in production', () => {
    expect(parseServerEnv({ APP_ENV: 'development', ...supabase }).apiDocsEnabled).toBe(true);
    expect(parseServerEnv({ APP_ENV: 'production', ...prod }).apiDocsEnabled).toBe(false);
    expect(parseServerEnv({ APP_ENV: 'production', ...prod, ENABLE_API_DOCS: 'true' }).apiDocsEnabled).toBe(true);
  });

  it('normalises trailing slashes and rejects malformed values', () => {
    const env = parseServerEnv({ APP_ENV: 'production', ...supabase, ...proxy, SUPABASE_URL: 'https://abc.supabase.co/', NEXT_PUBLIC_SITE_URL: 'https://www.shop.in/' });
    expect(env.supabase?.url).toBe('https://abc.supabase.co');
    expect(env.siteUrl).toBe('https://www.shop.in');
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, API_TIMEOUT_MS: '10' })).toThrow(EnvError);
    expect(() => parseServerEnv({ APP_ENV: 'development', ...supabase, ADMIN_SESSION_COOKIE: 'bad name;' })).toThrow(EnvError);
  });
});
