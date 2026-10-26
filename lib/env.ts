import { z } from 'zod';

/**
 * Server-side environment validation.
 *
 * This module is the single place `process.env` is read for application config.
 * It fails fast (at build or first request) when configuration is unsafe, e.g. mock
 * data enabled in production or a placeholder/non-HTTPS public site URL.
 */

const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const rawSchema = z.object({
  APP_ENV: z.preprocess(emptyToUndefined, z.enum(APP_ENVS).optional()),
  API_MODE: z.preprocess(emptyToUndefined, z.enum(['live', 'mock']).default('live')),
  API_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  API_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(500).max(60_000).default(8_000)),
  NEXT_PUBLIC_SITE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ADMIN_SESSION_COOKIE: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Za-z0-9_.-]+$/).default('o218_admin_session')),
  REVALIDATE_SECRET: z.preprocess(emptyToUndefined, z.string().min(24).optional()),
  MOCK_ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  MOCK_ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  MOCK_OTP_CODE: z.preprocess(emptyToUndefined, z.string().regex(/^\d{6}$/).optional()),
  CSP_EXTRA_SCRIPT_SRC: z.string().optional(),
  CSP_EXTRA_CONNECT_SRC: z.string().optional(),
  CSP_EXTRA_FRAME_SRC: z.string().optional(),
  CSP_EXTRA_IMG_SRC: z.string().optional(),
});

export type ServerEnv = {
  appEnv: AppEnv;
  isProduction: boolean;
  /** True only for local development and automated tests. Never true in staging/production. */
  mockEnabled: boolean;
  apiBaseUrl: string | null;
  apiTimeoutMs: number;
  siteUrl: string;
  adminSessionCookie: string;
  revalidateSecret: string | null;
  mockAdmin: { email: string; password: string } | null;
  mockOtpCode: string | null;
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
  const mockAllowed = appEnv === 'development' || appEnv === 'test';
  const mockEnabled = env.API_MODE === 'mock';

  if (mockEnabled && !mockAllowed) {
    throw new EnvError(`API_MODE=mock is only permitted when APP_ENV is "development" or "test" (got "${appEnv}"). Production must use the live API.`);
  }

  if (!mockEnabled && !env.API_BASE_URL) {
    throw new EnvError('API_BASE_URL is required when API_MODE=live. Point it at the backend REST API (see openapi/openapi.yaml).');
  }
  if (env.API_BASE_URL && isProduction && !env.API_BASE_URL.startsWith('https://')) {
    throw new EnvError('API_BASE_URL must use https:// in production.');
  }

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

  let mockAdmin: ServerEnv['mockAdmin'] = null;
  if (mockEnabled) {
    if (env.MOCK_ADMIN_EMAIL && env.MOCK_ADMIN_PASSWORD) mockAdmin = { email: env.MOCK_ADMIN_EMAIL, password: env.MOCK_ADMIN_PASSWORD };
  }

  return {
    appEnv,
    isProduction,
    mockEnabled,
    apiBaseUrl: env.API_BASE_URL ? env.API_BASE_URL.replace(/\/+$/, '') : null,
    apiTimeoutMs: env.API_TIMEOUT_MS,
    siteUrl: siteUrl.replace(/\/+$/, ''),
    adminSessionCookie: env.ADMIN_SESSION_COOKIE,
    revalidateSecret: env.REVALIDATE_SECRET ?? null,
    mockAdmin,
    mockOtpCode: mockEnabled ? env.MOCK_OTP_CODE ?? null : null,
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
