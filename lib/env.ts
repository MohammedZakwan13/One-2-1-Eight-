import { z } from 'zod';

/**
 * Server-side environment validation.
 *
 * This module is the single place `process.env` is read for application config.
 * It fails fast (at start or first request) when configuration is unsafe or incomplete, e.g. a missing
 * Supabase key or a placeholder/non-HTTPS public site URL in production.
 */

const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const rawSchema = z.object({
  APP_ENV: z.preprocess(emptyToUndefined, z.enum(APP_ENVS).optional()),
  /** `supabase` = built-in backend on Supabase (default). `live` = proxy to an external REST API at API_BASE_URL. */
  API_MODE: z.preprocess(emptyToUndefined, z.enum(['supabase', 'live']).default('supabase')),
  API_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  API_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(500).max(60_000).default(8_000)),
  NEXT_PUBLIC_SITE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ADMIN_SESSION_COOKIE: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Za-z0-9_.-]+$/).default('o218_admin_session')),
  ENABLE_API_DOCS: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
  REVALIDATE_SECRET: z.preprocess(emptyToUndefined, z.string().min(24).optional()),
  SUPABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_ANON_KEY: optionalString,
  /** `resend` (default, real delivery) or `mailpit` (local SMTP capture; rejected in production). */
  EMAIL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['resend', 'mailpit']).default('resend')),
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().default('localhost')),
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(1025)),
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: optionalString,
  INTERNAL_NOTIFICATION_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  RESEND_WEBHOOK_SECRET: optionalString,
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  MSG91_AUTH_KEY: optionalString,
  /** OTP Widget id and tokenAuth exactly as shown in the widget's generated Web SDK code (not the token's display label). Not secret, but kept server-side and handed to the browser at runtime. */
  MSG91_WIDGET_ID: optionalString,
  MSG91_WIDGET_TOKEN_AUTH: optionalString,
  /** Which proxy, if any, vouches for the client IP used by the IP rate limits. See lib/backend/client-ip.ts. */
  TRUSTED_PROXY: z.preprocess(emptyToUndefined, z.enum(['none', 'cloudflare', 'vercel']).default('none')),
  /** Set to "1" by the Vercel platform itself; it is the runtime proof that TRUSTED_PROXY=vercel requires. Never set it by hand. */
  VERCEL: z.string().optional(),
  /** Shared secret a Cloudflare Transform Rule adds as the X-O218-Origin-Secret request header, proving the request came through Cloudflare. */
  TRUSTED_PROXY_SECRET: z.preprocess(emptyToUndefined, z.string().min(24).optional()),
  CSP_EXTRA_SCRIPT_SRC: z.string().optional(),
  CSP_EXTRA_CONNECT_SRC: z.string().optional(),
  CSP_EXTRA_FRAME_SRC: z.string().optional(),
  CSP_EXTRA_IMG_SRC: z.string().optional(),
});

export type ServerEnv = {
  appEnv: AppEnv;
  isProduction: boolean;
  apiMode: 'supabase' | 'live';
  apiBaseUrl: string | null;
  apiTimeoutMs: number;
  siteUrl: string;
  adminSessionCookie: string;
  revalidateSecret: string | null;
  /** Swagger UI + OpenAPI JSON. On by default outside production; opt in with ENABLE_API_DOCS=true. */
  apiDocsEnabled: boolean;
  supabase: { url: string; serviceRoleKey: string; anonKey: string } | null;
  resend: { apiKey: string; from: string; internalEmail: string | null; webhookSecret: string | null } | null;
  /** Local-only SMTP capture (Mailpit). Null unless EMAIL_PROVIDER=mailpit outside production. */
  mailpit: { host: string; port: number; from: string; internalEmail: string | null } | null;
  razorpay: { keyId: string; keySecret: string; webhookSecret: string | null } | null;
  msg91: { authKey: string; widgetId: string; tokenAuth: string } | null;
  trustedProxy: { mode: 'none' } | { mode: 'cloudflare'; secret: string | null } | { mode: 'vercel'; onVercel: boolean };
};

export class EnvError extends Error {
  constructor(message: string) {
    super(`[env] ${message}`);
    this.name = 'EnvError';
  }
}

const PLACEHOLDER_HOST = /(^|\.)(example|invalid|localhost|test)$|example\.(com|org|net)$|your-|replace/i;

/** Pure, testable parser. `source` is usually `process.env`. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new EnvError(`Invalid environment configuration — ${details}`);
  }
  const env = parsed.data;
  const nodeEnv = source.NODE_ENV;
  // Safe default: anything built/run in production mode is treated as production unless explicitly overridden.
  const appEnv: AppEnv = env.APP_ENV ?? (nodeEnv === 'production' ? 'production' : 'development');
  const isProduction = appEnv === 'production';
  // `next build` evaluates modules without runtime secrets; they are enforced on the first real request/start.
  const building = source.NEXT_PHASE === 'phase-production-build';

  let supabase: ServerEnv['supabase'] = null;
  if (env.API_MODE === 'supabase') {
    const missing = [!env.SUPABASE_URL && 'SUPABASE_URL', !env.SUPABASE_SERVICE_ROLE_KEY && 'SUPABASE_SERVICE_ROLE_KEY', !env.SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY'].filter(Boolean);
    if (missing.length && !building) throw new EnvError(`${missing.join(', ')} required when API_MODE=supabase (Supabase Dashboard → Project Settings → API).`);
    if (!missing.length) {
      if (isProduction && !env.SUPABASE_URL!.startsWith('https://')) throw new EnvError('SUPABASE_URL must use https:// in production.');
      supabase = { url: env.SUPABASE_URL!.replace(/\/+$/, ''), serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!, anonKey: env.SUPABASE_ANON_KEY! };
    }
  } else {
    if (!env.API_BASE_URL) throw new EnvError('API_BASE_URL is required when API_MODE=live. Point it at the backend REST API (see openapi/openapi.yaml).');
    if (isProduction && !env.API_BASE_URL.startsWith('https://')) throw new EnvError('API_BASE_URL must use https:// in production.');
  }
  if (Boolean(env.RAZORPAY_KEY_ID) !== Boolean(env.RAZORPAY_KEY_SECRET)) throw new EnvError('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set together.');
  if (env.EMAIL_PROVIDER === 'mailpit' && isProduction) throw new EnvError('EMAIL_PROVIDER=mailpit is for local testing only and is not allowed when APP_ENV=production.');
  if (Boolean(env.RESEND_API_KEY) !== Boolean(env.EMAIL_FROM)) throw new EnvError('RESEND_API_KEY and EMAIL_FROM must be set together.');
  if (new Set([Boolean(env.MSG91_AUTH_KEY), Boolean(env.MSG91_WIDGET_ID), Boolean(env.MSG91_WIDGET_TOKEN_AUTH)]).size > 1) throw new EnvError('MSG91_AUTH_KEY, MSG91_WIDGET_ID and MSG91_WIDGET_TOKEN_AUTH must be set together.');

  if (env.TRUSTED_PROXY === 'cloudflare' && !env.TRUSTED_PROXY_SECRET && appEnv !== 'development' && !building) throw new EnvError('TRUSTED_PROXY=cloudflare needs TRUSTED_PROXY_SECRET (min 24 characters) outside development: without it a direct request to the origin could forge CF-Connecting-IP.');
  if (isProduction && env.TRUSTED_PROXY === 'none') throw new EnvError('TRUSTED_PROXY must name a supported trusted proxy (cloudflare or vercel) in production, so IP rate limits can use a verified client IP.');
  let siteUrl = env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    if (isProduction || appEnv === 'staging') throw new EnvError(`NEXT_PUBLIC_SITE_URL is required when APP_ENV=${appEnv} (used for canonical URLs, sitemap and structured data).`);
    siteUrl = 'http://localhost:3000';
  }
  const siteHost = new URL(siteUrl).hostname;
  if (isProduction) {
    if (!siteUrl.startsWith('https://')) throw new EnvError('NEXT_PUBLIC_SITE_URL must use https:// in production.');
    if (PLACEHOLDER_HOST.test(siteHost)) throw new EnvError(`NEXT_PUBLIC_SITE_URL host "${siteHost}" looks like a placeholder. Set the real production domain.`);
  }

  return {
    appEnv,
    isProduction,
    apiMode: env.API_MODE,
    apiBaseUrl: env.API_BASE_URL ? env.API_BASE_URL.replace(/\/+$/, '') : null,
    apiTimeoutMs: env.API_TIMEOUT_MS,
    siteUrl: siteUrl.replace(/\/+$/, ''),
    adminSessionCookie: env.ADMIN_SESSION_COOKIE,
    revalidateSecret: env.REVALIDATE_SECRET ?? null,
    apiDocsEnabled: env.ENABLE_API_DOCS ? env.ENABLE_API_DOCS === 'true' : !isProduction,
    supabase,
    mailpit: env.EMAIL_PROVIDER === 'mailpit' ? { host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.EMAIL_FROM ?? 'ONE 2 1 EIGHT <orders@one2oneight.local>', internalEmail: env.INTERNAL_NOTIFICATION_EMAIL ?? null } : null,
    resend: env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY && env.EMAIL_FROM ? { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, internalEmail: env.INTERNAL_NOTIFICATION_EMAIL ?? null, webhookSecret: env.RESEND_WEBHOOK_SECRET ?? null } : null,
    razorpay: env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? null } : null,
    trustedProxy: env.TRUSTED_PROXY === 'cloudflare' ? { mode: 'cloudflare', secret: env.TRUSTED_PROXY_SECRET ?? null } : env.TRUSTED_PROXY === 'vercel' ? { mode: 'vercel', onVercel: env.VERCEL === '1' } : { mode: 'none' },
    msg91: env.MSG91_AUTH_KEY && env.MSG91_WIDGET_ID && env.MSG91_WIDGET_TOKEN_AUTH ? { authKey: env.MSG91_AUTH_KEY, widgetId: env.MSG91_WIDGET_ID, tokenAuth: env.MSG91_WIDGET_TOKEN_AUTH } : null,
  };
}

let cached: ServerEnv | null = null;

/** Validated, memoised server env. Throws `EnvError` on unsafe configuration. */
export function getServerEnv(): ServerEnv {
  if (!cached) cached = parseServerEnv(process.env as Record<string, string | undefined>);
  return cached;
}

/** Test helper. */
export function resetServerEnvCache() {
  cached = null;
}
