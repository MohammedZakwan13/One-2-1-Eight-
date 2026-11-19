import type { z } from 'zod';
import { ApiError, errorFromResponse } from '@/lib/api/errors';
import { apiErrorBodySchema } from '@/lib/api/schemas';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined | readonly string[];

export type CallOptions = {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Required for order creation – lets the backend de-duplicate retried submissions. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Number of automatic retries. Only ever applied to GET requests. Default 2. */
  retries?: number;
  /** Base delay between retries in ms (linear backoff). Default 250. */
  retryDelayMs?: number;
  /** Server only: Next.js data-cache lifetime in seconds. `false` = never cache. */
  revalidate?: number | false;
  /** Server only: cache tags for on-demand revalidation. */
  tags?: string[];
  /** Server only: forward the incoming request cookies (needed for authenticated SSR such as the admin guard). */
  forwardCookies?: boolean;
};

export type TransportRequest = {
  method: HttpMethod;
  /** Path relative to the API root, always starting with `/`, including the query string. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  revalidate?: number | false;
  tags?: string[];
  forwardCookies?: boolean;
  /** Client IP already verified by the proxy route (see lib/backend/client-ip.ts). Never taken from request headers. */
  clientIp?: string;
};
export type Transport = (request: TransportRequest) => Promise<Response>;

/** Callable used by every repository. */
export type Caller = <S extends z.ZodType>(path: string, schema: S | null, options?: CallOptions) => Promise<S extends z.ZodType ? z.infer<S> : void>;

export function buildPath(path: string, query?: CallOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach(item => params.append(key, item));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Next.js uses thrown errors for control flow (dynamic rendering bail-outs, redirects, notFound). Never mask those. */
export function isFrameworkSignal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && /^(DYNAMIC_SERVER_USAGE|NEXT_|BAILOUT_TO_CLIENT_SIDE_RENDERING)/.test(digest);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(502, 'invalid_response', 'We received an unexpected response from the store. Please try again.');
  }
}

/**
 * Creates the typed API caller around a transport.
 * Handles retries (GET only), response validation and error normalisation.
 */
export function createCaller(transport: Transport): Caller {
  const attempt = async (path: string, schema: z.ZodType | null, options: CallOptions): Promise<unknown> => {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await transport({
        method, path: buildPath(path, options.query), headers, body, signal: options.signal,
        revalidate: options.revalidate, tags: options.tags, forwardCookies: options.forwardCookies,
      });
    } catch (error) {
      if (error instanceof ApiError || isFrameworkSignal(error)) throw error;
      if (error instanceof DOMException && error.name === 'AbortError' && options.signal?.aborted) throw error;
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ApiError(timedOut ? 504 : 503, timedOut ? 'timeout' : 'network_error',
        timedOut ? 'The store took too long to respond. Please try again.' : 'We could not reach the store. Check your connection and try again.');
    }

    if (!response.ok) {
      let parsedBody = null;
      try {
        const json = await readBody(response);
        const parsed = apiErrorBodySchema.safeParse(json);
        parsedBody = parsed.success ? parsed.data : null;
      } catch { /* non-JSON error body – fall back to a generic message */ }
      throw errorFromResponse(response.status, parsedBody);
    }

    if (!schema) return undefined;
    const json = await readBody(response);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Detail goes to server logs / devtools only – never into the UI.
      console.error(`[api] ${method} ${path} returned a response that does not match the contract`, parsed.error.issues.slice(0, 5));
      throw new ApiError(502, 'invalid_response', 'We received an unexpected response from the store. Please try again.');
    }
    return parsed.data;
  };

  return (async (path: string, schema: z.ZodType | null, options: CallOptions = {}) => {
    const method = options.method ?? 'GET';
    const maxRetries = method === 'GET' ? options.retries ?? 2 : 0;
    const delay = options.retryDelayMs ?? 250;
    let lastError: unknown;
    for (let tryIndex = 0; tryIndex <= maxRetries; tryIndex++) {
      try {
        return await attempt(path, schema, options);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ApiError && error.retryable && tryIndex < maxRetries && !isFrameworkSignal(error);
        if (!retryable) throw error;
        await sleep(delay * (tryIndex + 1) + Math.floor(Math.random() * 50));
      }
    }
    throw lastError;
  }) as Caller;
}
